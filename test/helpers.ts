import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import YAML from 'yaml';
import { loadTask, writeLock } from '../src/config.js';

export async function configuration(
  baseUrl = 'http://127.0.0.1:9/api/v4',
  patch: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'pi-sentinel-test-')),
    dir = join(root, 'tasks/review');
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'environments'));
  const task = {
    apiVersion: 'pi-sentinel/v1alpha1',
    id: 'review',
    owner: 'team',
    recipe: 'gitlab-refinement@1',
    connection: 'gitlab',
    scope: { projects: ['example/platform'], labels: ['refinement'] },
    trigger: { mode: 'once' },
    ...patch,
  };
  const platform = {
    connections: {
      gitlab: {
        kind: 'gitlab',
        baseUrl,
        allowedProjects: ['example/platform'],
        botUserId: 99,
        readTokenEnv: 'PI_SENTINEL_TEST_READ',
      },
    },
    models: { default: { baseUrl: baseUrl.replace('/api/v4', '/v1'), modelId: 'local-model' } },
  };
  await writeFile(join(dir, 'task.yaml'), YAML.stringify(task));
  await writeFile(join(root, 'environments/tst.yaml'), YAML.stringify(platform));
  const r = await loadTask(dir, 'tst', undefined, false);
  await writeLock(r);
  return { root, dir, r };
}
export async function mockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => Promise<void> | void,
) {
  const server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const c of req) text += c;
      await handler(req, res, text ? JSON.parse(text) : undefined);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
  };
}
export function json(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}
export function routerResponse(res: ServerResponse, body: any, result: any) {
  res.setHeader('content-type', 'text/event-stream');
  const done = (body.messages ?? []).some((m: any) => m.role === 'tool');
  const chunk = (delta: any, finish_reason: string | null = null, usage?: any) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'chat-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'local-model',
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        }) +
        '\n\n',
    );
  if (done) chunk({ role: 'assistant', content: 'Done' });
  else
    chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call-submit',
          type: 'function',
          function: { name: 'submit_result', arguments: JSON.stringify(result) },
        },
      ],
    });
  chunk({}, done ? 'stop' : 'tool_calls', {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  res.end('data: [DONE]\n\n');
}
export const evidence = () => ({
  id: 'example/platform#1',
  revision: 'revision-1',
  observedAt: new Date().toISOString(),
  refs: { 'example/platform#1': { title: 'Change', description: 'No acceptance criteria' } },
  coverage: 'complete' as const,
  missing: [],
  data: { project: 'example/platform', iid: 1, eligible: true },
});
export const result = () => ({
  status: 'needs_attention' as const,
  summary: 'Acceptance criteria are missing',
  findings: [
    {
      severity: 'medium' as const,
      text: 'No observable acceptance criteria',
      evidenceRefs: ['example/platform#1'],
    },
  ],
  questions: ['What observable result should demonstrate success?'],
  proposedAction: null,
});
