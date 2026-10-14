#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadTask, writeLock, explain } from './config.js';
import { State } from './state.js';
import { cycle, worker, adapterFor, fixtureAdapter } from './worker.js';
import { writeReport } from './report.js';
import { packageTask } from './package.js';
import { HttpClient } from './http.js';
import { recipes } from './recipes.js';
import { redact, hash } from './util.js';

const program = new Command()
  .name('sentinel')
  .version('0.1.0')
  .description('Bounded autonomous Pi task workers');
const task = program.command('task').description('Author, inspect and preview task bundles');
const emit = (value: unknown) => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};
const common = (cmd: Command) =>
  cmd
    .option('-e, --environment <name>', 'Environment binding', 'tst')
    .option('--platform <file>', 'Explicit environment YAML')
    .option('--json', 'Machine-readable output');
common(
  task
    .command('init <id>')
    .requiredOption('--recipe <name>')
    .option('--root <directory>', 'Task repository root', process.cwd()),
).action(async (id, o) => {
  const recipe = (o.recipe.includes('@') ? o.recipe : o.recipe + '@1') as keyof typeof recipes;
  if (!recipes[recipe] || !/^[a-z][a-z0-9-]{0,47}$/.test(id))
    throw new Error('Unknown recipe or invalid task ID');
  const dir = resolve(o.root, 'tasks', id);
  await mkdir(dir, { recursive: true });
  const kind = recipes[recipe].kind,
    scope =
      kind === 'gitlab'
        ? { projects: ['example/platform'], labels: ['technical-refinement'] }
        : kind === 'kubernetes'
          ? { namespaces: ['example-tst'] }
          : {};
  await writeFile(
    join(dir, 'task.yaml'),
    YAML.stringify({
      apiVersion: 'sentinel.pi/v1alpha1',
      id,
      owner: 'platform-team',
      recipe,
      connection: kind,
      scope,
      trigger: { mode: 'cron', schedule: '*/5 * * * *', timeZone: 'Europe/Amsterdam' },
      ...(kind === 'prometheus' ? { report: { queries: { availability: 'up' } } } : {}),
      output: { language: 'en', publish: false },
    }),
    { flag: 'wx' },
  );
  emit({
    created: dir,
    next: 'Configure environments/tst.yaml; resolve --write-lock, validate, explain and preview',
  });
});
common(task.command('resolve <dir>').requiredOption('--write-lock')).action(async (dir, o) => {
  const r = await loadTask(dir, o.environment, o.platform, false);
  await writeLock(r);
  emit({ locked: r.task.id, environment: r.environment, behaviorHash: r.behaviorHash });
});
common(task.command('validate <dir>')).action(async (dir, o) => {
  const r = await loadTask(dir, o.environment, o.platform);
  emit({ valid: true, task: r.task.id, environment: r.environment });
});
common(task.command('explain <dir>')).action(async (dir, o) =>
  emit(explain(await loadTask(dir, o.environment, o.platform))),
);
common(task.command('package <dir>').requiredOption('--out <directory>')).action(async (dir, o) =>
  emit(await packageTask(await loadTask(dir, o.environment, o.platform), resolve(o.out))),
);
common(
  task
    .command('preview <dir>')
    .option('--fixture <file>', 'Fixture JSON, relative to task directory')
    .option('--live', 'Read real sources using read-only credentials')
    .option('--item <id>', 'Exact project/path#IID or source identity')
    .option('--check-only', 'Validate recorded evidence without model calls')
    .option('--out <directory>', 'Report directory', 'artifacts/preview'),
).action(async (dir, o) => {
  if (Boolean(o.fixture) === Boolean(o.live))
    throw new Error('Choose exactly one of --fixture or --live');
  const r = await loadTask(dir, o.environment, o.platform);
  if (o.live && !o.item) throw new Error('Live preview requires an explicit --item');
  const adapter = o.fixture
    ? await fixtureAdapter(resolve(dir, o.fixture), r.tools)
    : adapterFor(r, true);
  const fixture = o.fixture
    ? JSON.parse(await readFile(resolve(dir, o.fixture), 'utf8'))
    : undefined;
  if (o.checkOnly) {
    if (!o.fixture) throw new Error('--check-only requires a fixture');
    let count = 0;
    for await (const e of adapter.discover(new AbortController().signal)) {
      if (!e.refs || !['complete', 'partial'].includes(e.coverage))
        throw new Error('Invalid evidence envelope');
      for (const ref of fixture.expectations?.requiredEvidenceRefs ?? [])
        if (!Object.hasOwn(e.refs, ref))
          throw new Error('Fixture is missing expected reference ' + ref);
      count++;
    }
    emit({ valid: true, items: count, modelCalls: 0, qualityEvaluated: false });
    return;
  }
  const state = new State(':memory:');
  try {
    const reports = await cycle(r, state, {
      preview: true,
      adapter,
      item: o.item,
      artifacts: resolve(o.out),
    });
    if (!reports.length)
      throw new Error('No successful preview result; inspect the preceding diagnostics');
    for (const report of reports) {
      const ex = fixture?.expectations;
      if (
        ex?.maximumQuestions !== undefined &&
        report.result.questions.length > ex.maximumQuestions
      )
        throw new Error('Fixture maximum question count exceeded');
      if (
        report.result.proposedAction &&
        ex?.forbiddenActions?.includes(report.result.proposedAction.playbook)
      )
        throw new Error('Fixture forbids the proposed action');
    }
    await writeReport(resolve(o.out), reports.at(-1)!);
    emit({ preview: true, reports: reports.length, directory: resolve(o.out), published: false });
  } finally {
    state.close();
  }
});
common(
  task.command('doctor <dir>').option('--model', 'Also perform a tiny model/tool-call probe'),
).action(async (dir, o) => {
  const r = await loadTask(dir, o.environment, o.platform);
  const client = new HttpClient(r.platform.connections[r.task.connection]!, true),
    s = AbortSignal.timeout(30000);
  const path =
    client.config.kind === 'gitlab'
      ? '/user'
      : client.config.kind === 'kubernetes'
        ? '/api'
        : '/api/v1/status/buildinfo';
  await client.request(path, s);
  emit({ source: 'reachable', kind: client.config.kind, modelProbeRequested: Boolean(o.model) });
  if (o.model) {
    const { runAgent } = await import('./pi-adapter.js');
    const evidence = {
      id: 'doctor',
      revision: hash('doctor'),
      observedAt: new Date().toISOString(),
      refs: { doctor: { healthy: true } },
      coverage: 'complete' as const,
      missing: [],
      data: { probe: true },
    };
    const result = await runAgent(
      {
        ...r,
        tools: [],
        prompt:
          'Submit a healthy result with summary "Connectivity probe", no findings or questions and no action using submit_result.',
      },
      evidence,
      [],
      s,
      { before() {}, after() {} },
    );
    emit({ model: 'tool-call-compatible', usage: result.usage });
  }
});
task
  .command('status')
  .option('--state <file>', 'State database', '/state/sentinel.sqlite')
  .action(async (o) => {
    const db = new State(o.state, true);
    try {
      emit(db.status());
    } finally {
      db.close();
    }
  });
task
  .command('reprocess <source-id>')
  .option('--state <file>', 'State database', '/state/sentinel.sqlite')
  .action(async (id, o) => {
    if (process.env.SENTINEL_MAINTENANCE !== 'true')
      throw new Error('Stop the worker and set SENTINEL_MAINTENANCE=true before state maintenance');
    const db = new State(o.state);
    try {
      if (!db.item(id)) throw new Error('Unknown source');
      db.reprocess(id);
      emit({ queued: id });
    } finally {
      db.close();
    }
  });
common(
  program
    .command('worker <dir>')
    .option('--state <file>', 'State database', '/state/sentinel.sqlite')
    .option('--artifacts <directory>', 'Bounded report directory')
    .option('--port <port>', 'Health/metrics port', '9090')
    .option('--lock-held', 'Internal flock child'),
).action(async (dir, o) => {
  const r = await loadTask(dir, o.environment, o.platform);
  if (!o.lockHeld) {
    const { dirname } = await import('node:path');
    await mkdir(dirname(resolve(o.state)), { recursive: true });
    const args = [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
      '--lock-held',
    ];
    const child = spawn(
      'flock',
      [
        '--nonblock',
        '--conflict-exit-code',
        '75',
        '--no-fork',
        resolve(o.state) + '.lock',
        process.execPath,
        ...args,
      ],
      { stdio: 'inherit' },
    );
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGTERM', terminate);
    process.once('SIGINT', terminate);
    const code = await new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('exit', (c) => done(c ?? 1));
    });
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    process.exitCode = code;
    return;
  }
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  const state = new State(o.state);
  state.recover();
  try {
    await worker(r, state, stop.signal, o.artifacts, Number(o.port));
    if (state.get('lastError') && r.task.trigger.mode !== 'continuous') process.exitCode = 1;
  } finally {
    state.close();
  }
});
program.parseAsync().catch((error) => {
  process.stderr.write(redact(error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
