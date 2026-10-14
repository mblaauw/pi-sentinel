import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { configuration, mockServer, json, routerResponse, evidence, result } from './helpers.js';
import { runAgent } from '../src/pi-adapter.js';
import { GitLabAdapter } from '../src/adapters/gitlab.js';
import { publish, repair } from '../src/effects.js';
import { State } from '../src/state.js';
import type { RunReport } from '../src/contracts.js';
import { noteBody, html } from '../src/report.js';
import { HttpClient } from '../src/http.js';

test('actual pinned Pi SDK uses the router, structured tool and bounded tool set', async () => {
  let requests = 0;
  const server = await mockServer((req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.ok(!JSON.stringify(body.messages[0]).includes('sentinel-session-'));
    requests++;
    assert.ok(body.max_tokens <= 4000 || body.max_completion_tokens <= 4000);
    assert.deepEqual(
      body.tools.map((t: any) => t.function.name),
      ['submit_result'],
    );
    routerResponse(res, body, result());
  });
  const { root, r } = await configuration(server.url + '/api/v4');
  try {
    r.tools = [];
    let reservations = 0;
    const answer = await runAgent(r, evidence(), [], AbortSignal.timeout(15000), {
      before() {
        reservations++;
      },
      after() {},
    });
    assert.equal(answer.result.status, 'needs_attention');
    assert.equal(answer.result.questions.length, 1);
    assert.ok(requests >= 1);
    assert.equal(reservations, requests);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('request allowance is enforced before any model HTTP request', async () => {
  let requests = 0;
  const server = await mockServer((_q, res) => {
    requests++;
    json(res, {});
  });
  const { root, r } = await configuration(server.url + '/api/v4');
  try {
    r.tools = [];
    await assert.rejects(
      runAgent(r, evidence(), [], AbortSignal.timeout(10000), {
        before() {
          throw new Error('Budget denied');
        },
        after() {},
      }),
    );
    assert.equal(requests, 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('GitLab evidence excludes bot replies but includes exact linked issue context', async () => {
  const server = await mockServer((req, res) => {
    const path = new URL(req.url!, 'http://local').pathname;
    if (path.endsWith('/notes'))
      return json(res, [
        { id: 1, author: { id: 99 }, body: 'bot', system: false },
        { id: 2, author: { id: 3 }, body: 'human', system: false },
      ]);
    if (path.endsWith('/links'))
      return json(res, [
        {
          project_id: 42,
          iid: 2,
          web_url: 'https://gitlab.example.internal/example/platform/-/issues/2',
        },
      ]);
    return json(res, {
      iid: path.endsWith('/2') ? 2 : 1,
      project_id: 42,
      title: 'Task',
      description: path.endsWith('/2') ? 'Linked criteria' : 'Task without an inline link',
      labels: ['refinement'],
      state: 'opened',
    });
  });
  const { root, r } = await configuration(server.url + '/api/v4');
  try {
    const adapter = new GitLabAdapter(r);
    const e = await adapter.gather('example/platform', 1, new AbortController().signal);
    assert.equal(e.coverage, 'complete');
    assert.ok(e.refs['example/platform#2']);
    assert.equal((e.refs[e.id] as any).notes.length, 1);
    assert.equal((e.refs[e.id] as any).notes[0].body, 'human');
    await assert.rejects(
      adapter.getIssue('other/project', 1, new AbortController().signal),
      /scope/,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
function report(): RunReport {
  return {
    taskId: 'review',
    environment: 'tst',
    runId: 'run1',
    sourceId: 'example/platform#1',
    behaviorHash: 'behavior',
    evidenceRevision: 'evidence',
    observedAt: new Date().toISOString(),
    coverage: 'complete',
    missing: [],
    result: result(),
    usage: { calls: 1, input: 1, output: 1, cacheRead: 0, known: true },
    durationMs: 100,
    effects: [],
    preview: false,
  };
}
test('publication reconciles a remote note after local state loss', async () => {
  let notes: any[] = [],
    posts = 0,
    puts = 0;
  const server = await mockServer((req, res, body) => {
    if (req.url === '/api/v4/user') return json(res, { id: 99 });
    if (req.method === 'POST') {
      posts++;
      notes.push({ id: 7, author: { id: 99 }, body: body.body });
      return json(res, notes[0]);
    }
    if (req.method === 'PUT') {
      puts++;
      notes[0].body = body.body;
      return json(res, notes[0]);
    }
    json(res, notes);
  });
  const { root, r } = await configuration(server.url + '/api/v4');
  r.task.output.publish = true;
  r.platform.policy.allowPublish = true;
  const s = new State(':memory:'),
    lost = new State(':memory:');
  try {
    await publish(r, s, report(), new AbortController().signal);
    await publish(r, lost, report(), new AbortController().signal);
    assert.equal(posts, 1);
    assert.equal(puts, 1);
    await publish(r, lost, report(), new AbortController().signal);
    assert.equal(puts, 1);
    const preview = { ...report(), preview: true };
    assert.equal((await publish(r, lost, preview, new AbortController().signal)).status, 'skipped');
  } finally {
    s.close();
    lost.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('preview API clients refuse mutations; reports escape HTML and GitLab commands', async () => {
  const { root, r } = await configuration();
  try {
    const client = new HttpClient(r.platform.connections.gitlab!, true);
    await assert.rejects(
      client.request('/issues', new AbortController().signal, 'POST', {}),
      /cannot mutate/,
    );
    const rep = report();
    rep.result.summary = '/close\n<script>alert(1)</script>';
    assert.ok(noteBody(rep).includes('> /close'));
    assert.ok(!html(rep).includes('<script>'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('repair rejects a target not present in the claimed evidence before any API call', async () => {
  const { root, r } = await configuration();
  const state = new State(':memory:');
  try {
    r.task.actions.mode = 'auto';
    r.task.actions.allowedPlaybooks = ['restart-opted-in-deployment'];
    const receipt = await repair(
      r,
      state,
      {
        playbook: 'restart-opted-in-deployment',
        namespace: 'test',
        name: 'wrong',
        uid: 'uid',
        reason: 'failure',
      },
      { namespace: 'test', owner: 'right', ownerUid: 'uid' },
      new AbortController().signal,
    );
    assert.equal(receipt.status, 'skipped');
    assert.match(receipt.detail, /claimed/);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
