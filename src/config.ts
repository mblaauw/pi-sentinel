import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import YAML from 'yaml';
import { taskSchema, environmentSchema, type Task, type Environment } from './contracts.js';
import { recipes } from './recipes.js';
import { hash, safeRead, atomicWrite } from './util.js';
import { CronExpressionParser } from 'cron-parser';

export interface Resolved {
  task: Task;
  platform: Environment;
  environment: string;
  dir: string;
  resources: Record<string, string>;
  behaviorHash: string;
  packageHash: string;
  tools: string[];
  prompt: string;
}
const RUNTIME = '0.1.0:pi-1.2.0';
export async function loadTask(
  dir: string,
  environment: string,
  platformFile?: string,
  locked = true,
): Promise<Resolved> {
  dir = resolve(dir);
  const task = taskSchema.parse(YAML.parse(await readFile(join(dir, 'task.yaml'), 'utf8')));
  const platformPath = platformFile ?? resolve(dir, '../../environments', environment + '.yaml');
  const platform = environmentSchema.parse(YAML.parse(await readFile(platformPath, 'utf8')));
  if (task.trigger.mode === 'cron')
    CronExpressionParser.parse(task.trigger.schedule!, { tz: task.trigger.timeZone });
  const recipe = recipes[task.recipe],
    connection = platform.connections[task.connection];
  if (!connection || connection.kind !== recipe.kind)
    throw new Error(`connection '${task.connection}' must be ${recipe.kind}`);
  for (const p of task.scope.projects)
    if (!connection.allowedProjects.includes(p))
      throw new Error(`scope.projects: '${p}' is outside connection '${task.connection}'`);
  for (const n of task.scope.namespaces)
    if (!connection.allowedNamespaces.includes(n))
      throw new Error(`scope.namespaces: '${n}' is outside connection '${task.connection}'`);
  if (recipe.kind === 'gitlab' && !task.scope.projects.length)
    throw new Error('GitLab recipe requires scope.projects');
  if (recipe.kind === 'kubernetes' && !task.scope.namespaces.length)
    throw new Error('Kubernetes recipe requires scope.namespaces');
  if (task.actions.mode === 'auto' && !platform.policy.allowAuto)
    throw new Error('Environment policy denies automatic repair');
  if (task.output.publish && !platform.policy.allowPublish)
    throw new Error('Environment policy denies publication');
  if (
    task.limits.maxCallsPerDay > platform.policy.maxCallsPerDay ||
    task.limits.maxTokensPerDay > platform.policy.maxTokensPerDay
  )
    throw new Error('Task allowance exceeds environment policy');
  if (!platform.models[task.agent.modelProfile])
    throw new Error(`Missing model profile '${task.agent.modelProfile}'`);
  const model = platform.models[task.agent.modelProfile]!;
  if (
    task.limits.maxRequestInputTokens + task.limits.maxOutputTokensPerCall > model.contextWindow ||
    task.limits.maxOutputTokensPerCall > model.maxOutputTokens
  )
    throw new Error('Task context/output budgets exceed model limits');
  if (
    task.trigger.mode !== 'continuous' &&
    platform.job.startupSeconds +
      task.limits.maxWallSecondsPerCycle +
      platform.job.terminationSeconds >=
      platform.job.activeDeadlineSeconds
  )
    throw new Error('Job deadline must exceed startup + cycle + termination budgets');
  if (task.limits.maxWallSecondsPerCycle < task.limits.maxWallSecondsPerItem)
    throw new Error('Cycle budget is shorter than one item budget');
  task.output.type ??= recipe.output;
  if (task.output.type !== 'stdout') {
    const output = platform.connections[task.output.connection ?? task.connection];
    if (!output || output.kind !== 'gitlab')
      throw new Error('GitLab output needs a GitLab connection');
    if (
      task.output.type === 'gitlab.issue-note' &&
      (!task.output.projectPath ||
        !task.output.issueIid ||
        !output.allowedProjects.includes(task.output.projectPath))
    )
      throw new Error('Issue-note output requires an allowed projectPath and issueIid');
    if (task.output.type === 'gitlab.item-note' && recipe.kind !== 'gitlab')
      throw new Error('Item-note output requires GitLab issue source');
  }
  const tools = task.agent.tools ?? [...recipe.tools];
  const resources: Record<string, string> = {};
  const paths = [
    task.instructions,
    task.agent.systemPrompt,
    ...task.agent.skills.map((s) => (s.endsWith('.md') ? s : join(s, 'SKILL.md'))),
    task.flow?.file,
    ...task.extensions,
  ].filter((p): p is string => Boolean(p));
  for (const file of paths) resources[file] = await safeRead(dir, file);
  if (task.flow?.type === 'custom' && !task.flow.file)
    throw new Error('Custom flow requires flow.file');
  if (Buffer.byteLength(JSON.stringify(resources)) > 500 * 1024)
    throw new Error('Task resources exceed 500 KiB bundle limit');
  const behaviorHash = hash({
    task,
    platform,
    resources,
    recipeVersion: recipe.version,
    runtime: RUNTIME,
  });
  const resolved: Resolved = {
    task,
    platform,
    environment,
    dir,
    resources,
    tools,
    behaviorHash,
    packageHash: hash({ task, resources }),
    prompt: [
      systemPromptFor(task, resources),
      recipe.prompt,
      task.instructions ? resources[task.instructions] : '',
      ...task.agent.skills.map((s) => resources[s.endsWith('.md') ? s : join(s, 'SKILL.md')]),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
  if (locked) {
    const lock = JSON.parse(await readFile(join(dir, 'task.lock.json'), 'utf8'));
    if (lock.runtime !== RUNTIME || lock.environments?.[environment] !== behaviorHash)
      throw new Error(
        `task.lock.json is stale for ${environment}; run task resolve --write-lock and review the diff`,
      );
  }
  return resolved;
}
import { systemPrompt } from './recipes.js';
function systemPromptFor(task: Task, resources: Record<string, string>) {
  return task.agent.systemPrompt
    ? systemPrompt + '\n\n' + resources[task.agent.systemPrompt]
    : systemPrompt;
}
export async function writeLock(r: Resolved) {
  let old: { environments?: Record<string, string> } = {};
  try {
    old = JSON.parse(await readFile(join(r.dir, 'task.lock.json'), 'utf8'));
  } catch {}
  await atomicWrite(
    join(r.dir, 'task.lock.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        runtime: RUNTIME,
        recipe: r.task.recipe,
        recipeVersion: recipes[r.task.recipe].version,
        resources: hash(r.resources),
        environments: { ...old.environments, [r.environment]: r.behaviorHash },
      },
      null,
      2,
    ) + '\n',
  );
}
export function explain(r: Resolved) {
  return {
    id: r.task.id,
    owner: r.task.owner,
    environment: r.environment,
    recipe: r.task.recipe,
    revision: r.behaviorHash,
    trigger: r.task.trigger,
    scope: r.task.scope,
    model: r.task.agent.modelProfile,
    tools: r.tools,
    actions: r.task.actions,
    output: r.task.output,
    limits: r.task.limits,
    evidence: r.task.evidence,
    connections: Object.fromEntries(
      Object.entries(r.platform.connections).map(([k, c]) => [
        k,
        {
          kind: c.kind,
          baseUrl: c.baseUrl,
          tokenEnv: c.tokenEnv,
          readTokenEnv: c.readTokenEnv,
          allowedProjects: c.allowedProjects,
          allowedNamespaces: c.allowedNamespaces,
        },
      ]),
    ),
    origins: {
      tools: r.task.agent.tools ? 'task' : 'recipe',
      prompt: 'system + recipe + task resources',
      connections: 'environment',
      limits: 'schema defaults + task, constrained by environment',
      policy: 'environment ceiling',
    },
  };
}
