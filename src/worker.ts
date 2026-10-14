import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import type { Resolved } from './config.js';
import type { Adapter, Evidence, Tool, RunReport, AgentResult, Usage } from './contracts.js';
import { resultSchema } from './contracts.js';
import { GitLabAdapter } from './adapters/gitlab.js';
import { KubernetesAdapter } from './adapters/kubernetes.js';
import { PrometheusAdapter } from './adapters/prometheus.js';
import { State } from './state.js';
import type { CallBudget } from './pi-adapter.js';
import { repair, publish } from './effects.js';
import { writeReport } from './report.js';
import { log, sleep, redact, hash } from './util.js';
import type { CustomFlow, CustomTool } from './host.js';

export function adapterFor(r: Resolved, preview = false): Adapter {
  return r.task.recipe === 'gitlab-refinement@1'
    ? new GitLabAdapter(r, preview)
    : r.task.recipe === 'kubernetes-care@1'
      ? new KubernetesAdapter(r, preview)
      : new PrometheusAdapter(r, preview);
}
export async function fixtureAdapter(path: string, names: string[] = []): Promise<Adapter> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    evidence: Evidence[];
    toolResults?: Record<string, unknown>;
  };
  if (!Array.isArray(raw.evidence) || !raw.evidence.length)
    throw new Error('Fixture requires a nonempty evidence array');
  for (const e of raw.evidence)
    if (!e.id || !e.revision || !e.refs || !e.observedAt)
      throw new Error('Invalid fixture evidence');
  return {
    async *discover() {
      yield* structuredClone(raw.evidence);
    },
    async refresh(e) {
      return e;
    },
    tools(e) {
      return [...new Set([...names, ...Object.keys(raw.toolResults ?? {})])].map((name) => ({
        name,
        description: 'Recorded fixture evidence',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        execute: async (a) => {
          if (
            name === 'get_linked_issue' &&
            typeof a.ref === 'string' &&
            Object.hasOwn(e.refs, a.ref)
          )
            return e.refs[a.ref];
          if (Object.hasOwn(raw.toolResults ?? {}, name)) return raw.toolResults![name];
          throw new Error(`No recorded fixture response for '${name}'`);
        },
      }));
    },
  };
}
export interface ExecuteOptions {
  preview?: boolean;
  artifacts?: string;
  adapter?: Adapter;
  item?: string;
  reprocess?: boolean;
  signal?: AbortSignal;
}
export async function cycle(
  r: Resolved,
  state: State,
  options: ExecuteOptions = {},
): Promise<RunReport[]> {
  const preview = options.preview ?? false,
    outer = options.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([
      outer,
      AbortSignal.timeout(r.task.limits.maxWallSecondsPerCycle * 1000),
    ]),
    start = Date.now();
  const adapter = options.adapter ?? adapterFor(r, preview),
    reports: RunReport[] = [];
  let calls = 0,
    actions = 0,
    discoveryFailed = false;
  const hostFile = new URL(
    import.meta.url.endsWith('.ts') ? './host.ts' : './host.js',
    import.meta.url,
  );
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      'sentinel-pi': fileURLToPath(hostFile),
      yaml: fileURLToPath(import.meta.resolve('yaml')),
      zod: fileURLToPath(import.meta.resolve('zod')),
    },
  });
  const customTools: CustomTool[] = [];
  for (const path of r.task.extensions) {
    const loaded = (await jiti.import(resolve(r.dir, path), { default: true })) as
      | CustomTool
      | CustomTool[];
    for (const tool of Array.isArray(loaded) ? loaded : [loaded]) {
      if (
        !tool.manifest ||
        tool.manifest.effect !== 'read' ||
        tool.manifest.name !== tool.name ||
        !Number.isInteger(tool.manifest.timeoutSeconds) ||
        tool.manifest.timeoutSeconds < 1 ||
        !Number.isInteger(tool.manifest.maxOutputBytes) ||
        tool.manifest.maxOutputBytes < 1
      )
        throw new Error('Custom tools require a bounded read manifest');
      if (customTools.some((t) => t.name === tool.name))
        throw new Error('Duplicate custom tool: ' + tool.name);
      customTools.push(tool);
    }
  }
  try {
    const collect = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1000, Math.floor(r.task.limits.maxWallSecondsPerCycle * 200))),
    ]);
    for await (const collected of adapter.discover(collect)) {
      if (options.item && collected.id !== options.item) continue;
      let e = collected;
      const prior = state.item(e.id);
      if (r.task.recipe === 'kubernetes-care@1' && (e.data as any)?.recovered && !prior) continue;
      if (adapter instanceof GitLabAdapter && prior) {
        const previous = JSON.parse(prior.evidence) as Evidence;
        if (Object.values(previous.refs).some((v) => (v as any)?.repository))
          e = await adapter.refresh(previous, collect);
      }
      state.enqueue(e);
      if (options.reprocess) state.reprocess(e.id);
    }
    state.set('lastDiscovery', new Date().toISOString());
    state.set('lastError', '');
  } catch (e) {
    discoveryFailed = true;
    state.set('lastError', redact(String(e)));
    log('discovery_failed', { task_id: r.task.id, error: redact(String(e)) });
  }
  for (const pending of state.pending(r.task.lifecycle.maxAttempts)) {
    if (reports.length >= r.task.limits.maxItemsPerCycle || signal.aborted) break;
    if (options.item && pending.id !== options.item) continue;
    if (
      Date.now() - start + r.task.limits.maxWallSecondsPerItem * 1000 >
      r.task.limits.maxWallSecondsPerCycle * 1000
    )
      break;
    let e = JSON.parse(pending.evidence) as Evidence;
    if (!preview) {
      try {
        e = await adapter.refresh(e, signal);
        state.enqueue(e);
      } catch (error) {
        state.start(e.id);
        state.fail(e.id, redact(String(error)), r.task.lifecycle.retrySeconds);
        state.set('lastError', redact(String(error)));
        log('item_refresh_failed', {
          task_id: r.task.id,
          source_id: e.id,
          error: redact(String(error)),
        });
        continue;
      }
    }
    if ((e.data as any)?.eligible === false) {
      if (r.task.recipe === 'kubernetes-care@1' && (e.data as any)?.recovered) {
        const report: RunReport = {
          taskId: r.task.id,
          environment: r.environment,
          runId: randomUUID(),
          sourceId: e.id,
          behaviorHash: r.behaviorHash,
          evidenceRevision: e.revision,
          observedAt: e.observedAt,
          coverage: e.coverage,
          missing: [],
          result: {
            status: 'healthy',
            summary:
              'The previously observed pod is now Running and Ready. This does not establish the cause of recovery.',
            findings: [],
            questions: [],
            proposedAction: null,
          },
          usage: { calls: 0, input: 0, output: 0, cacheRead: 0, known: true },
          durationMs: 0,
          effects: [],
          preview,
        };
        report.effects.push(await publish(r, state, report, signal));
        state.complete(e.id, report);
        reports.push(report);
        log('incident_recovered', { task_id: r.task.id, source_id: e.id });
      } else state.defer(e.id, r.task.lifecycle.revalidateSeconds);
      continue;
    }
    if (
      !preview &&
      r.task.recipe === 'kubernetes-care@1' &&
      Date.now() - pending.first_seen < r.task.evidence.minimumFailureAgeSeconds * 1000
    ) {
      state.defer(
        e.id,
        r.task.evidence.minimumFailureAgeSeconds -
          Math.floor((Date.now() - pending.first_seen) / 1000),
      );
      continue;
    }
    const itemSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(r.task.limits.maxWallSecondsPerItem * 1000),
      ]),
      itemStart = Date.now();
    const old = state.item(e.id);
    state.start(e.id);
    let report: RunReport | undefined;
    try {
      const usage: Usage = { calls: 0, input: 0, output: 0, cacheRead: 0, known: true };
      let itemCalls = 0,
        itemTools = 0;
      const budget: CallBudget = {
        before(estimate) {
          const used = state.usage();
          if (
            ++itemCalls > r.task.limits.maxTurnsPerItem ||
            ++calls > r.task.limits.maxLlmCallsPerCycle ||
            used.calls + 1 > r.task.limits.maxCallsPerDay ||
            used.tokens + estimate > r.task.limits.maxTokensPerDay
          )
            throw new Error('Task model allowance exhausted');
          state.reserve(1, estimate);
        },
        after(actual, estimated) {
          if (actual > 0) state.reconcileTokens(actual - estimated);
        },
        tool() {
          if (++itemTools > r.task.limits.maxToolCallsPerItem)
            throw new Error('Item tool allowance exhausted');
        },
      };
      const tools = [
        ...adapter.tools(e),
        ...customTools.map((t) => ({
          ...t,
          execute: async (a: Record<string, unknown>, s: AbortSignal) => {
            const data = await t.execute(
              a,
              AbortSignal.any([s, AbortSignal.timeout(t.manifest.timeoutSeconds * 1000)]),
            );
            if (Buffer.byteLength(JSON.stringify(data)) > t.manifest.maxOutputBytes)
              throw new Error('Custom tool output exceeds manifest limit');
            return data;
          },
        })),
      ];
      if (new Set(tools.map((t) => t.name)).size !== tools.length)
        throw new Error('Tool name collision');
      const agentRun = async (
        options: { instructions?: string; tools?: string[] } = {},
      ): Promise<AgentResult> => {
        if (options.tools?.some((n) => !r.tools.includes(n)))
          throw new Error('A flow cannot widen the active tool allowlist');
        const selected = options.tools
          ? tools.filter((t) => options.tools!.includes(t.name))
          : tools;
        const rr = {
          ...r,
          tools: options.tools ?? r.tools,
          prompt: r.prompt + (options.instructions ? '\n\n' + options.instructions : ''),
        };
        const { runAgent } = await import('./pi-adapter.js');
        const result = await runAgent(rr, e, selected, itemSignal, budget);
        usage.calls += result.usage.calls;
        usage.input += result.usage.input;
        usage.output += result.usage.output;
        usage.cacheRead += result.usage.cacheRead;
        usage.known &&= result.usage.known;
        return result.result;
      };
      // Reuse the validated result after a publication/verification interruption.
      const saved = old?.report ? (JSON.parse(old.report) as RunReport) : undefined;
      if (saved && saved.evidenceRevision === e.revision && saved.behaviorHash === r.behaviorHash)
        report = {
          ...saved,
          usage: { calls: 0, input: 0, output: 0, cacheRead: 0, known: true },
          effects: saved.effects.filter((x) => x.status === 'executed'),
        };
      else {
        let result: AgentResult;
        if (r.task.flow?.type === 'custom') {
          const flow = (await jiti.import(resolve(r.dir, r.task.flow.file!), {
            default: true,
          })) as CustomFlow;
          result = resultSchema.parse(await flow({ evidence: e, agent: { run: agentRun } }));
        } else result = await agentRun();
        for (const finding of result.findings)
          for (const ref of finding.evidenceRefs)
            if (!Object.hasOwn(e.refs, ref))
              throw new Error(`Result cites uncollected evidence: ${ref}`);
        if (result.proposedAction && r.task.recipe !== 'kubernetes-care@1')
          throw new Error('This recipe cannot propose infrastructure actions');
        if (e.coverage === 'partial' && result.status === 'healthy') result.status = 'inconclusive';
        report = {
          taskId: r.task.id,
          environment: r.environment,
          runId: randomUUID(),
          sourceId: e.id,
          behaviorHash: r.behaviorHash,
          evidenceRevision: e.revision,
          observedAt: e.observedAt,
          coverage: e.coverage,
          missing: e.missing,
          result,
          usage,
          durationMs: Date.now() - itemStart,
          effects: [],
          preview,
        };
      }
      state.enqueue(e);
      state.saveReport(e.id, report);
      if (report.result.proposedAction && !preview) {
        const current = await adapter.refresh(e, itemSignal);
        if (current.revision !== e.revision || (current.data as any)?.eligible === false) {
          state.enqueue(current);
          state.defer(e.id, r.task.lifecycle.retrySeconds);
          log('stale_action_deferred', { task_id: r.task.id, source_id: e.id });
          continue;
        }
      }
      if (report.result.proposedAction && actions >= r.task.actions.maxActionsPerCycle) {
        report.effects.push({ status: 'skipped', detail: 'Cycle action allowance exhausted' });
      }
      if (report.result.proposedAction && actions < r.task.actions.maxActionsPerCycle) {
        const receipt = await repair(
          r,
          state,
          report.result.proposedAction,
          e.data as any,
          itemSignal,
          preview,
        );
        report.effects.push(receipt);
        if (receipt.status === 'executed' || receipt.status === 'uncertain') actions++;
        if (receipt.status === 'uncertain') {
          state.saveReport(e.id, report);
          throw new Error(receipt.detail);
        }
      }
      if (!preview && r.task.recipe === 'gitlab-refinement@1') {
        const fresh = await adapter.refresh(e, itemSignal);
        if (fresh.revision !== e.revision || (fresh.data as any)?.eligible === false) {
          state.enqueue(fresh);
          state.defer(e.id, r.task.lifecycle.retrySeconds);
          log('stale_result_deferred', { task_id: r.task.id, source_id: e.id });
          continue;
        }
      }
      state.saveReport(e.id, report);
      report.effects.push(await publish(r, state, report, itemSignal));
      report.durationMs = Date.now() - itemStart;
      state.complete(e.id, report);
      reports.push(report);
      if (r.task.output.type === 'stdout') log('run_report', { task_id: r.task.id, report });
      if (options.artifacts) await writeReport(join(options.artifacts, report.runId), report);
      log('run_completed', {
        task_id: r.task.id,
        source_id: e.id,
        status: report.result.status,
        coverage: e.coverage,
        usage: report.usage,
        run_id: report.runId,
        duration_ms: report.durationMs,
      });
    } catch (err) {
      const error = redact(String(err));
      state.fail(e.id, error, r.task.lifecycle.retrySeconds);
      state.set('lastError', error);
      log('item_failed', { task_id: r.task.id, source_id: e.id, error });
    }
  }
  state.prune(r.task.state.retentionDays);
  if (discoveryFailed && !reports.length)
    throw new Error('Discovery failed; inspect lastError and source connectivity');
  return reports;
}

export async function worker(
  r: Resolved,
  state: State,
  signal: AbortSignal,
  artifacts?: string,
  port = 9090,
) {
  let healthy = false,
    working = false;
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.end('ok');
      return;
    }
    if (req.url === '/readyz') {
      res.statusCode = healthy ? 200 : 503;
      res.end(healthy ? 'ready' : 'degraded');
      return;
    }
    if (req.url === '/metrics') {
      const u = state.usage();
      res.setHeader('content-type', 'text/plain');
      res.end(
        `sentinel_worker_working ${working ? 1 : 0}\nsentinel_worker_ready ${healthy ? 1 : 0}\nsentinel_daily_model_calls ${u.calls}\nsentinel_daily_reserved_tokens ${u.tokens}\nsentinel_last_discovery_timestamp_seconds ${Date.parse(state.get('lastDiscovery') ?? '') / 1000 || 0}\n`,
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  if (r.task.trigger.mode === 'continuous') server.listen(port, '0.0.0.0');
  let failures = 0;
  try {
    do {
      if (!r.task.enabled) {
        log('task_paused', { task_id: r.task.id });
        break;
      }
      working = true;
      try {
        await cycle(r, state, { signal, artifacts });
        healthy = !state.get('lastError') && !state.hasFailures();
        failures = 0;
      } catch (e) {
        healthy = false;
        failures++;
        log('cycle_failed', { task_id: r.task.id, error: redact(String(e)) });
      } finally {
        working = false;
      }
      if (r.task.trigger.mode !== 'continuous') break;
      await sleep(
        (Math.min(3600, r.task.trigger.intervalSeconds * 2 ** Math.min(failures, 6)) +
          Math.random() * r.task.trigger.jitterSeconds) *
          1000,
        signal,
      );
    } while (!signal.aborted);
  } finally {
    server.close();
  }
}
