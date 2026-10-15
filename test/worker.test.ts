import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration, mockServer, routerResponse, result, evidence, json } from './helpers.js';
import { cycle } from '../src/worker.js';
import { State } from '../src/state.js';
import { repair } from '../src/effects.js';
import type { Adapter, Evidence } from '../src/contracts.js';

test('worker skips unchanged items, isolates preview and emits an actual HTML report', async () => {
  let calls = 0;
  const server = await mockServer((_req, res, body) => {
    calls++;
    routerResponse(res, body, result());
  });
  const { root, r } = await configuration(server.url + '/api/v4');
  r.tools = [];
  const state = new State(':memory:');
  const adapter: Adapter = {
    async *discover() {
      yield evidence();
    },
    async refresh(e) {
      return e;
    },
    tools() {
      return [];
    },
  };
  try {
    const reports = await cycle(r, state, {
      preview: true,
      adapter,
      artifacts: join(root, 'reports'),
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.preview, true);
    assert.ok(
      (await readFile(join(root, 'reports', reports[0]!.runId, 'report.html'), 'utf8')).includes(
        'Pi Sentinel',
      ),
    );
    const prior = calls;
    assert.equal((await cycle(r, state, { preview: true, adapter })).length, 0);
    assert.equal(calls, prior);
    r.behaviorHash = 'new-prompt-revision';
    await cycle(r, state, { preview: true, adapter });
    assert.equal(calls, prior);
  } finally {
    state.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('a custom TypeScript flow works against the same bounded host API', async () => {
  const server = await mockServer((_req, res, body) => routerResponse(res, body, result()));
  const { root, r } = await configuration(server.url + '/api/v4');
  const state = new State(':memory:');
  r.tools = [];
  await writeFile(
    join(r.dir, 'flow.ts'),
    'import {defineFlow} from "pi-sentinel"; export default defineFlow(async ctx => ctx.agent.run({instructions:"Be specific", tools:[]}));',
  );
  r.task.flow = { type: 'custom', file: 'flow.ts' };
  const adapter: Adapter = {
    async *discover() {
      yield evidence();
    },
    async refresh(e) {
      return e;
    },
    tools() {
      return [];
    },
  };
  try {
    assert.equal((await cycle(r, state, { preview: true, adapter })).length, 1);
  } finally {
    state.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('repair patches only an opted-in replicated deployment and verifies rollout', async () => {
  let patches = 0;
  const deployment: any = {
    metadata: {
      name: 'app',
      namespace: 'test',
      uid: 'owner-1',
      resourceVersion: '1',
      generation: 1,
      annotations: { 'pi-sentinel/auto-repair': 'true' },
    },
    spec: {
      replicas: 2,
      strategy: { type: 'RollingUpdate' },
      template: { metadata: { annotations: {} }, spec: { volumes: [] } },
    },
    status: { observedGeneration: 1, availableReplicas: 1, updatedReplicas: 2, replicas: 2 },
  };
  const server = await mockServer((req, res, body) => {
    if (req.method === 'PATCH') {
      patches++;
      assert.equal(req.headers['content-type'], 'application/json-patch+json');
      assert.equal(body[0].path, '/metadata/uid');
      deployment.spec.template.metadata.annotations = body[2].value;
      deployment.metadata.generation = 2;
      deployment.status = {
        observedGeneration: 2,
        availableReplicas: 2,
        updatedReplicas: 2,
        replicas: 2,
      };
    }
    json(res, deployment);
  });
  const { root, r } = await configuration();
  r.task.recipe = 'kubernetes-care@1';
  r.task.connection = 'kube';
  r.task.scope.namespaces = ['test'];
  r.task.actions.mode = 'auto';
  r.task.actions.allowedPlaybooks = ['restart-opted-in-deployment'];
  r.platform.policy.allowAuto = true;
  r.platform.connections.kube = {
    kind: 'kubernetes',
    baseUrl: server.url,
    allowedProjects: [],
    allowedNamespaces: ['test'],
    writableDeployments: ['test/app'],
  };
  const state = new State(':memory:'),
    action = {
      playbook: 'restart-opted-in-deployment' as const,
      namespace: 'test',
      name: 'app',
      uid: 'owner-1',
      reason: 'Transient failure',
    },
    source = { namespace: 'test', owner: 'app', ownerUid: 'owner-1', pod: 'app-1' };
  try {
    assert.equal(
      (await repair(r, state, action, source, AbortSignal.timeout(5000))).verified,
      true,
    );
    assert.equal(
      (await repair(r, state, action, source, AbortSignal.timeout(5000))).verified,
      true,
    );
    assert.equal(patches, 1);
    const cooldown = await repair(
      r,
      state,
      action,
      { ...source, pod: 'app-2' },
      AbortSignal.timeout(5000),
    );
    assert.match(cooldown.detail, /cooldown/);
  } finally {
    state.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('known healthy recovery reports without model inference', async () => {
  const { root, r } = await configuration();
  r.task.recipe = 'kubernetes-care@1';
  r.task.output.type = 'stdout';
  const state = new State(':memory:');
  const e = evidence();
  state.enqueue(e);
  state.db.prepare("UPDATE work SET status='done' WHERE id=?").run(e.id);
  const healed: Evidence = { ...e, revision: 'ready', data: { eligible: false, recovered: true } };
  const adapter: Adapter = {
    async *discover() {
      yield healed;
    },
    async refresh(e) {
      return e;
    },
    tools() {
      return [];
    },
  };
  try {
    const reports = await cycle(r, state, { adapter });
    assert.equal(reports[0]!.result.status, 'healthy');
    assert.equal(reports[0]!.usage.calls, 0);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an inaccessible queued source does not starve other work', async () => {
  const { root, r } = await configuration();
  r.task.recipe = 'kubernetes-care@1';
  r.task.output.type = 'stdout';
  const state = new State(':memory:');
  const first = evidence(),
    second = {
      ...evidence(),
      id: 'example/platform#2',
      revision: 'ready',
      data: { eligible: false, recovered: true },
    };
  state.enqueue(first);
  state.enqueue({ ...second, revision: 'old', data: { eligible: true } });
  const adapter: Adapter = {
    async *discover() {
      yield first;
      yield second;
    },
    async refresh(e) {
      if (e.id === first.id) throw new Error('Source was deleted');
      return e;
    },
    tools() {
      return [];
    },
  };
  try {
    const reports = await cycle(r, state, { adapter });
    assert.equal(state.item(first.id)!.status, 'failed');
    assert.equal(reports[0]!.sourceId, second.id);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
