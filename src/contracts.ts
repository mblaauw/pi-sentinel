import { z } from 'zod';

const positive = z.number().int().positive();
export const scopeSchema = z
  .object({
    projects: z.array(z.string().min(1)).default([]),
    labels: z.array(z.string()).default([]),
    namespaces: z.array(z.string().min(1)).default([]),
    deployments: z.array(z.string()).default([]),
  })
  .strict();
export const limitsSchema = z
  .object({
    maxItemsPerCycle: positive.default(5),
    maxWallSecondsPerCycle: positive.default(600),
    maxTurnsPerItem: positive.default(12),
    maxToolCallsPerItem: positive.default(30),
    maxWallSecondsPerItem: positive.default(120),
    maxRequestInputTokens: positive.default(32000),
    maxOutputTokensPerCall: positive.default(4000),
    maxLlmCallsPerCycle: positive.default(60),
    maxCallsPerDay: positive.default(200),
    maxTokensPerDay: positive.default(1000000),
  })
  .strict();
const triggerSchema = z
  .object({
    mode: z.enum(['once', 'cron', 'continuous']).default('once'),
    schedule: z.string().optional(),
    timeZone: z.string().default('Europe/Amsterdam'),
    intervalSeconds: positive.default(60),
    jitterSeconds: z.number().int().nonnegative().default(10),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v.timeZone });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid timeZone' });
    }
    if (v.mode === 'cron' && (!v.schedule || v.schedule.trim().split(/\s+/).length !== 5))
      ctx.addIssue({ code: 'custom', message: 'cron mode requires a five-field schedule' });
    if (v.mode !== 'cron' && v.schedule)
      ctx.addIssue({ code: 'custom', message: 'schedule requires cron mode' });
  });
export const taskSchema = z
  .object({
    apiVersion: z.literal('sentinel.pi/v1alpha1'),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    owner: z.string().min(1),
    recipe: z.enum(['gitlab-refinement@1', 'kubernetes-care@1', 'platform-report@1']),
    connection: z.string().min(1),
    enabled: z.boolean().default(true),
    scope: scopeSchema.default({}),
    trigger: triggerSchema.default({}),
    instructions: z.string().optional(),
    agent: z
      .object({
        modelProfile: z.string().default('default'),
        tools: z.array(z.string()).optional(),
        skills: z.array(z.string()).default([]),
        systemPrompt: z.string().optional(),
      })
      .strict()
      .default({}),
    flow: z
      .object({
        type: z.enum(['review', 'investigate', 'report', 'custom']),
        file: z.string().optional(),
      })
      .strict()
      .optional(),
    extensions: z.array(z.string()).default([]),
    limits: limitsSchema.default({}),
    evidence: z
      .object({
        maxRefs: positive.default(12),
        maxDepth: positive.default(2),
        maxBytes: positive.default(12000),
        maxTotalBytes: positive.default(24000),
        maxLogLines: positive.default(100),
        minimumFailureAgeSeconds: z.number().int().nonnegative().default(180),
      })
      .strict()
      .default({}),
    actions: z
      .object({
        mode: z.enum(['report', 'propose', 'auto']).default('report'),
        allowedPlaybooks: z.array(z.literal('restart-opted-in-deployment')).default([]),
        maxActionsPerItem: positive.default(1),
        maxActionsPerCycle: positive.default(1),
        cooldownSeconds: positive.default(1800),
      })
      .strict()
      .default({}),
    output: z
      .object({
        type: z.enum(['stdout', 'gitlab.item-note', 'gitlab.issue-note']).optional(),
        connection: z.string().optional(),
        projectPath: z.string().optional(),
        issueIid: positive.optional(),
        language: z.string().default('en'),
        publish: z.boolean().default(false),
      })
      .strict()
      .default({}),
    lifecycle: z
      .object({
        revalidateSeconds: positive.default(300),
        retrySeconds: positive.default(60),
        maxAttempts: positive.default(3),
      })
      .strict()
      .default({}),
    report: z
      .object({
        window: z.enum(['previous-day', 'last-hour']).default('previous-day'),
        queries: z.record(z.string()).default({}),
        catchUpWindows: positive.default(3),
      })
      .strict()
      .default({}),
    state: z
      .object({ retentionDays: positive.default(30) })
      .strict()
      .default({}),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;
export const connectionSchema = z
  .object({
    kind: z.enum(['gitlab', 'kubernetes', 'prometheus']),
    baseUrl: z.string().url(),
    tokenEnv: z.string().optional(),
    readTokenEnv: z.string().optional(),
    tokenFile: z.string().optional(),
    caFile: z.string().optional(),
    allowedProjects: z.array(z.string()).default([]),
    allowedNamespaces: z.array(z.string()).default([]),
    writableDeployments: z.array(z.string()).default([]),
    botUserId: positive.optional(),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export const environmentSchema = z
  .object({
    connections: z.record(connectionSchema),
    models: z.record(
      z
        .object({
          baseUrl: z.string().url(),
          modelId: z.string().min(1),
          apiKeyEnv: z.string().optional(),
          contextWindow: positive.default(65536),
          maxOutputTokens: positive.default(4096),
          reasoning: z.boolean().default(false),
        })
        .strict(),
    ),
    policy: z
      .object({
        allowAuto: z.boolean().default(false),
        allowPublish: z.boolean().default(false),
        maxCallsPerDay: positive.default(500),
        maxTokensPerDay: positive.default(2000000),
      })
      .strict()
      .default({}),
    job: z
      .object({
        activeDeadlineSeconds: positive.default(720),
        startupSeconds: positive.default(30),
        terminationSeconds: positive.default(30),
      })
      .strict()
      .default({}),
  })
  .strict();
export type Environment = z.infer<typeof environmentSchema>;
export const actionSchema = z
  .object({
    playbook: z.literal('restart-opted-in-deployment'),
    namespace: z.string(),
    name: z.string(),
    uid: z.string(),
    reason: z.string().min(1),
  })
  .strict();
export type ProposedAction = z.infer<typeof actionSchema>;
export const resultSchema = z
  .object({
    status: z.enum(['healthy', 'needs_attention', 'inconclusive', 'failed']),
    summary: z.string().min(1).max(3000),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['low', 'medium', 'high']),
            text: z.string().max(2000),
            evidenceRefs: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .max(20),
    questions: z.array(z.string().min(1).max(1000)).max(5),
    proposedAction: actionSchema.nullable().default(null),
  })
  .strict();
export type AgentResult = z.infer<typeof resultSchema>;
export interface Evidence {
  id: string;
  revision: string;
  observedAt: string;
  refs: Record<string, unknown>;
  coverage: 'complete' | 'partial';
  missing: string[];
  data: unknown;
}
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}
export interface Usage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  known: boolean;
}
export interface EffectReceipt {
  status: 'executed' | 'proposed' | 'skipped' | 'failed' | 'uncertain';
  detail: string;
  verified?: boolean;
}
export interface RunReport {
  taskId: string;
  environment: string;
  runId: string;
  sourceId: string;
  behaviorHash: string;
  evidenceRevision: string;
  observedAt: string;
  coverage: Evidence['coverage'];
  missing: string[];
  result: AgentResult;
  usage: Usage;
  durationMs: number;
  effects: EffectReceipt[];
  preview: boolean;
}
export interface Adapter {
  discover(signal: AbortSignal): AsyncIterable<Evidence>;
  refresh(item: Evidence, signal: AbortSignal): Promise<Evidence>;
  tools(item: Evidence): Tool[];
}
