import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Resolved } from './config.js';
import { atomicWrite, hash } from './util.js';
export async function packageTask(r: Resolved, out: string) {
  const files: Record<string, string> = {
    'task.yaml': await readFile(join(r.dir, 'task.yaml'), 'utf8'),
    'task.lock.json': await readFile(join(r.dir, 'task.lock.json'), 'utf8'),
    'platform.yaml': YAML.stringify(r.platform),
    ...r.resources,
  };
  for (const p of Object.keys(files))
    if (p.startsWith('/') || p.split(/[\\/]/).includes('..'))
      throw new Error('Unsafe package path');
  const name = `${r.task.id}-${hash(files).slice(0, 12)}`;
  const data: Record<string, string> = {},
    items: Array<{ key: string; path: string }> = [];
  for (const [path, value] of Object.entries(files)) {
    const key = 'f' + items.length;
    data[key] = value;
    items.push({ key, path });
  }
  const configmap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      labels: { 'app.kubernetes.io/part-of': 'sentinel-pi', 'sentinel.pi/task': r.task.id },
    },
    immutable: true,
    data,
  };
  if (Buffer.byteLength(JSON.stringify(configmap)) > 500 * 1024)
    throw new Error('Serialized ConfigMap exceeds package size limit');
  await mkdir(out, { recursive: true });
  await atomicWrite(join(out, 'task-configmap.yaml'), YAML.stringify(configmap));
  const values = {
    task: {
      id: r.task.id,
      configMapName: name,
      environment: r.environment,
      revision: r.packageHash,
      mode: r.task.trigger.mode,
      schedule: r.task.trigger.schedule ?? '',
      timeZone: r.task.trigger.timeZone,
      enabled: r.task.enabled,
      files: items,
    },
    job: { activeDeadlineSeconds: r.platform.job.activeDeadlineSeconds },
    runtime: {
      cycleSeconds: r.task.limits.maxWallSecondsPerCycle,
      startupSeconds: r.platform.job.startupSeconds,
      terminationSeconds: r.platform.job.terminationSeconds,
    },
    kubernetes: {
      enabled: r.task.recipe === 'kubernetes-care@1',
      namespaces: r.task.scope.namespaces,
      writeDeployments:
        r.task.actions.mode === 'auto'
          ? r.platform.connections[r.task.connection]!.writableDeployments
          : [],
    },
  };
  await atomicWrite(join(out, 'task-values.yaml'), YAML.stringify(values));
  return { name, files: items.length };
}
