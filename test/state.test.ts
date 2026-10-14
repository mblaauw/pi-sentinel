import test from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../src/state.js';
import { evidence } from './helpers.js';
import { reportWindows } from '../src/adapters/prometheus.js';
import { redact } from '../src/util.js';

test('redaction preserves JSON structure for credential-like strings', () => {
  const source = { password: 'hidden', summary: 'password=hidden', message: 'token: hidden' };
  const text = redact(JSON.stringify(source));
  assert.doesNotThrow(() => JSON.parse(text));
  assert.ok(!text.includes('hidden'));
});

test('unchanged sources and task restarts do not requeue completed work', () => {
  const s = new State(':memory:');
  try {
    const e = evidence();
    s.enqueue(e);
    s.start(e.id);
    s.db.prepare("UPDATE work SET status='done' WHERE id=?").run(e.id);
    s.enqueue(e);
    assert.equal(s.pending(3).length, 0);
    s.enqueue({ ...e, revision: 'new' });
    assert.equal(s.pending(3).length, 1);
  } finally {
    s.close();
  }
});
test('usage reservations, cooldowns and effect intents survive logical retries', () => {
  const s = new State(':memory:');
  try {
    s.reserve(1, 1000);
    s.reconcileTokens(-800);
    assert.deepEqual(s.usage(), { calls: 1, tokens: 200 });
    s.setCooldown('owner', 60);
    assert.equal(s.cooldown('owner'), true);
    s.intent('action', { annotation: 'one' });
    s.intent('action', { annotation: 'two' });
    assert.equal(s.effect('action')!.intent.annotation, 'one');
  } finally {
    s.close();
  }
});
test('Amsterdam daily windows cover DST transition days correctly', () => {
  const spring = reportWindows(
    new Date('2026-03-30T10:00:00Z'),
    'Europe/Amsterdam',
    'previous-day',
    1,
  )[0]!;
  assert.equal(spring.end - spring.start, 23 * 3600000);
  const fall = reportWindows(
    new Date('2026-10-26T10:00:00Z'),
    'Europe/Amsterdam',
    'previous-day',
    1,
  )[0]!;
  assert.equal(fall.end - fall.start, 25 * 3600000);
});
