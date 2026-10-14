import {
  createAgentSession,
  ModelRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResult, Evidence, Tool, Usage } from './contracts.js';
import { resultSchema } from './contracts.js';
import type { Resolved } from './config.js';
import { redact } from './util.js';

export interface CallBudget {
  before(estimatedTokens: number): void;
  after(actualTokens: number, estimatedTokens: number): void;
  tool?(): void;
}
const resultJson = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['healthy', 'needs_attention', 'inconclusive', 'failed'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          text: { type: 'string' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'text', 'evidenceRefs'],
        additionalProperties: false,
      },
    },
    questions: { type: 'array', maxItems: 5, items: { type: 'string' } },
    proposedAction: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            playbook: { type: 'string', enum: ['restart-opted-in-deployment'] },
            namespace: { type: 'string' },
            name: { type: 'string' },
            uid: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['playbook', 'namespace', 'name', 'uid', 'reason'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['status', 'summary', 'findings', 'questions', 'proposedAction'],
  additionalProperties: false,
};
export async function runAgent(
  r: Resolved,
  evidence: Evidence,
  tools: Tool[],
  signal: AbortSignal,
  budget: CallBudget,
): Promise<{ result: AgentResult; usage: Usage }> {
  const temp = await mkdtemp(join(tmpdir(), 'sentinel-session-'));
  const modelConfig = r.platform.models[r.task.agent.modelProfile]!;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsStorePath: join(temp, 'models-store.json'),
  });
  runtime.registerProvider('sentinel-internal', {
    baseUrl: modelConfig.baseUrl,
    api: 'openai-completions',
    apiKey: modelConfig.apiKeyEnv ? process.env[modelConfig.apiKeyEnv] : 'internal',
    models: [
      {
        id: modelConfig.modelId,
        name: modelConfig.modelId,
        reasoning: modelConfig.reasoning,
        input: ['text'],
        contextWindow: modelConfig.contextWindow,
        maxTokens: r.task.limits.maxOutputTokensPerCall,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  if (modelConfig.apiKeyEnv && !process.env[modelConfig.apiKeyEnv])
    throw new Error(`Missing model credential '${modelConfig.apiKeyEnv}'`);
  const model = runtime.getModel('sentinel-internal', modelConfig.modelId);
  if (!model) throw new Error('Configured model not registered');
  const usage: Usage = { calls: 0, input: 0, output: 0, cacheRead: 0, known: true };
  let calls = 0,
    toolCalls = 0,
    candidate: AgentResult | undefined,
    reservation = 0;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: 'off',
  });
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (selected, context, options) => {
    signal.throwIfAborted();
    if (++calls > r.task.limits.maxTurnsPerItem) throw new Error('Model turn budget exhausted');
    // A conservative byte-count estimate deliberately favors bounded execution.
    const estimated = Buffer.byteLength(JSON.stringify(context));
    if (estimated > r.task.limits.maxRequestInputTokens)
      throw new Error('Estimated input context exceeds task limit');
    reservation = estimated + r.task.limits.maxOutputTokensPerCall;
    budget.before(reservation);
    usage.calls++;
    return stream(selected, context, {
      ...options,
      maxTokens: r.task.limits.maxOutputTokensPerCall,
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: temp,
    agentDir: temp,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: r.prompt,
    // Pi otherwise adds per-session context sections containing the temporary cwd.
    // Force the task's stable prefix while retaining its explicit tool declarations.
    extensionFactories: [
      (pi) => {
        pi.on('before_agent_start', () => ({ systemPrompt: r.prompt }));
      },
    ],
  });
  await loader.reload();
  const customTools: ToolDefinition[] = [
    ...tools
      .filter((t) => r.tools.includes(t.name))
      .map((t) => ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: Type.Unsafe(t.parameters),
        executionMode: 'sequential' as const,
        execute: async (_id: string, args: unknown, toolSignal: AbortSignal | undefined) => {
          budget.tool?.();
          if (++toolCalls > r.task.limits.maxToolCallsPerItem)
            throw new Error('Tool budget exhausted');
          let output: unknown;
          try {
            output = await t.execute(
              args as Record<string, unknown>,
              AbortSignal.any([signal, ...(toolSignal ? [toolSignal] : [])]),
            );
          } catch (error) {
            evidence.coverage = 'partial';
            evidence.missing.push(t.name + ':' + redact(String(error)));
            throw error;
          }
          const text = redact(JSON.stringify(output) ?? 'null');
          if (Buffer.byteLength(text) > r.task.evidence.maxBytes) {
            evidence.coverage = 'partial';
            evidence.missing.push(t.name + ':truncated');
          }
          return {
            content: [{ type: 'text' as const, text: text.slice(0, r.task.evidence.maxBytes) }],
            details: {},
          };
        },
      })),
    {
      name: 'submit_result',
      label: 'Submit result',
      description:
        'Submit the structured final task result. This does not publish or execute an action.',
      parameters: Type.Unsafe(resultJson),
      execute: async (_id, args) => {
        budget.tool?.();
        const result = resultSchema.parse(args);
        for (const f of result.findings)
          for (const ref of f.evidenceRefs)
            if (!Object.hasOwn(evidence.refs, ref))
              throw new Error(`Unknown evidence reference: ${ref}`);
        if (r.task.recipe !== 'kubernetes-care@1' && result.proposedAction)
          throw new Error('This recipe cannot propose infrastructure actions');
        candidate = result;
        return { content: [{ type: 'text', text: 'Result accepted. End the turn.' }], details: {} };
      },
    },
  ];
  for (const name of r.tools)
    if (!tools.some((t) => t.name === name)) throw new Error(`Unavailable tool '${name}'`);
  const { session } = await createAgentSession({
    cwd: temp,
    agentDir: temp,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    tools: customTools.map((t) => t.name),
    customTools,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(),
  });
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const msg = event.message as any,
        u = msg.usage;
      if (u) {
        const actual = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        usage.input += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        budget.after(actual, reservation);
        reservation = 0;
      } else usage.known = false;
    }
  });
  try {
    signal.throwIfAborted();
    const input = redact(
      JSON.stringify({
        task: r.task.id,
        language: r.task.output.language,
        allowedPlaybooks: r.task.actions.allowedPlaybooks,
        evidence,
      }),
    );
    await session.prompt(input);
    if (!candidate && !signal.aborted)
      await session.prompt(
        'No valid result was submitted. Submit one valid result using only retrieved evidence, then end.',
      );
    signal.throwIfAborted();
    if (!candidate) throw new Error('No valid structured result submitted');
    return { result: candidate, usage };
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', abort);
    session.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}
