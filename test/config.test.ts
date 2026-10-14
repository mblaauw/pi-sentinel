import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from './helpers.js';
import { loadTask, writeLock } from '../src/config.js';
import { safeRead } from '../src/util.js';
import { packageTask } from '../src/package.js';
import YAML from 'yaml';

test('recipe expands deterministically; a changed prompt invalidates the lock', async () => {
  const { root, dir, r } = await configuration();
  try {
    assert.deepEqual((await loadTask(dir, 'tst')).tools, r.tools);
    const raw = YAML.parse(await readFile(join(dir, 'task.yaml'), 'utf8'));
    raw.instructions = 'prompt.md';
    await writeFile(join(dir, 'prompt.md'), 'Be specific');
    await writeFile(join(dir, 'task.yaml'), YAML.stringify(raw));
    await assert.rejects(loadTask(dir, 'tst'), /stale/);
    const next = await loadTask(dir, 'tst', undefined, false);
    await writeLock(next);
    assert.equal((await loadTask(dir, 'tst')).behaviorHash, next.behaviorHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('scope, policy, unknown keys and actual cron ranges fail early', async () => {
  for (const patch of [
    { scope: { projects: ['other/project'] } },
    { actions: { mode: 'auto' } },
    { surprise: true },
    { trigger: { mode: 'cron', schedule: '80 * * * *' } },
  ]) {
    await assert.rejects(configuration(undefined, patch));
  }
});
test('safe resources reject traversal and symlinks outside the task', async () => {
  const { root, dir } = await configuration();
  try {
    await writeFile(join(root, 'secret'), 'private');
    await symlink(join(root, 'secret'), join(dir, 'escape'));
    await assert.rejects(safeRead(dir, 'escape'), /escapes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('task packaging is immutable, hashes environment content, and preserves file paths', async () => {
  const { root, r } = await configuration();
  try {
    const out = join(root, 'package');
    const p = await packageTask(r, out);
    const cm = YAML.parse(await readFile(join(out, 'task-configmap.yaml'), 'utf8'));
    const values = YAML.parse(await readFile(join(out, 'task-values.yaml'), 'utf8'));
    assert.equal(cm.immutable, true);
    assert.equal(cm.metadata.name, p.name);
    assert.ok(values.task.files.some((x: any) => x.path === 'platform.yaml'));
    assert.equal(values.runtime.cycleSeconds, 600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
