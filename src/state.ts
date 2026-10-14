import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Evidence, RunReport, EffectReceipt } from './contracts.js';

export class State {
  readonly db: DatabaseSync;
  constructor(path: string, readOnly = false) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    if (readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY,revision TEXT NOT NULL,evidence TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,error TEXT,report TEXT);
      CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY,intent TEXT NOT NULL,receipt TEXT,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outputs (key TEXT PRIMARY KEY,note_id INTEGER,content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY,calls INTEGER NOT NULL,tokens INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cooldowns (key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,report TEXT NOT NULL,created INTEGER NOT NULL);
    `);
    const version = this.get('schemaVersion');
    if (version && version !== '1') throw new Error('Unsupported state schema version');
    this.set('schemaVersion', '1');
  }
  recover() {
    this.db.prepare("UPDATE work SET status='pending' WHERE status='running'").run();
  }
  get(key: string) {
    return (
      this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value);
  }
  enqueue(e: Evidence) {
    const now = Date.now(),
      old = this.item(e.id);
    if (!old) {
      this.db
        .prepare('INSERT INTO work(id,revision,evidence,first_seen,last_seen) VALUES (?,?,?,?,?)')
        .run(e.id, e.revision, JSON.stringify(e), now, now);
    } else if (old.revision !== e.revision) {
      const recovered = Boolean((JSON.parse(old.evidence).data as any)?.recovered);
      this.db
        .prepare(
          "UPDATE work SET revision=?,evidence=?,status='pending',attempts=0,retry_at=0,last_seen=?,first_seen=? WHERE id=?",
        )
        .run(e.revision, JSON.stringify(e), now, recovered ? now : old.first_seen, e.id);
    } else
      this.db
        .prepare('UPDATE work SET evidence=?,last_seen=? WHERE id=?')
        .run(JSON.stringify(e), now, e.id);
  }
  item(id: string) {
    return this.db.prepare('SELECT * FROM work WHERE id=?').get(id) as
      | {
          id: string;
          revision: string;
          evidence: string;
          status: string;
          attempts: number;
          retry_at: number;
          first_seen: number;
          report?: string;
        }
      | undefined;
  }
  pending(maxAttempts: number) {
    return this.db
      .prepare(
        "SELECT * FROM work WHERE status IN ('pending','failed') AND attempts<? AND retry_at<=? ORDER BY first_seen,id",
      )
      .all(maxAttempts, Date.now()) as Array<{
      id: string;
      evidence: string;
      attempts: number;
      first_seen: number;
    }>;
  }
  start(id: string) {
    this.db.prepare("UPDATE work SET status='running',attempts=attempts+1 WHERE id=?").run(id);
  }
  saveReport(id: string, report: RunReport) {
    this.db.prepare('UPDATE work SET report=? WHERE id=?').run(JSON.stringify(report), id);
  }
  complete(id: string, report: RunReport) {
    const json = JSON.stringify(report);
    this.db.prepare("UPDATE work SET status='done',error=NULL,report=? WHERE id=?").run(json, id);
    this.db
      .prepare('INSERT OR REPLACE INTO runs VALUES (?,?,?)')
      .run(report.runId, json, Date.now());
  }
  fail(id: string, error: string, retrySeconds: number) {
    const a = this.item(id)?.attempts ?? 1;
    this.db
      .prepare("UPDATE work SET status='failed',error=?,retry_at=? WHERE id=?")
      .run(error, Date.now() + Math.min(3600, retrySeconds * 2 ** Math.min(a - 1, 6)) * 1000, id);
  }
  defer(id: string, seconds: number) {
    this.db
      .prepare("UPDATE work SET status='pending',retry_at=? WHERE id=?")
      .run(Date.now() + seconds * 1000, id);
  }
  reprocess(id: string) {
    this.db.prepare("UPDATE work SET status='pending',attempts=0,retry_at=0 WHERE id=?").run(id);
  }
  usage() {
    const d = new Date().toISOString().slice(0, 10);
    const value = this.db.prepare('SELECT calls,tokens FROM usage WHERE day=?').get(d) as
      | { calls: number; tokens: number }
      | undefined;
    return { calls: value?.calls ?? 0, tokens: value?.tokens ?? 0 };
  }
  reserve(calls: number, tokens: number) {
    const d = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        'INSERT INTO usage VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET calls=calls+excluded.calls,tokens=tokens+excluded.tokens',
      )
      .run(d, calls, tokens);
  }
  reconcileTokens(delta: number) {
    this.reserve(0, delta);
  }
  effect(key: string) {
    const x = this.db.prepare('SELECT intent,receipt FROM effects WHERE key=?').get(key) as
      | { intent: string; receipt?: string }
      | undefined;
    return x
      ? {
          intent: JSON.parse(x.intent),
          receipt: x.receipt ? (JSON.parse(x.receipt) as EffectReceipt) : undefined,
        }
      : undefined;
  }
  intent(key: string, value: unknown) {
    this.db
      .prepare('INSERT OR IGNORE INTO effects VALUES (?,?,NULL,?)')
      .run(key, JSON.stringify(value), Date.now());
  }
  receipt(key: string, value: EffectReceipt) {
    this.db
      .prepare('UPDATE effects SET receipt=?,updated=? WHERE key=?')
      .run(JSON.stringify(value), Date.now(), key);
  }
  cooldown(key: string) {
    return (
      ((
        this.db.prepare('SELECT until_ms FROM cooldowns WHERE key=?').get(key) as
          | { until_ms: number }
          | undefined
      )?.until_ms ?? 0) > Date.now()
    );
  }
  setCooldown(key: string, seconds: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO cooldowns VALUES (?,?)')
      .run(key, Date.now() + seconds * 1000);
  }
  output(key: string) {
    return this.db.prepare('SELECT note_id,content_hash FROM outputs WHERE key=?').get(key) as
      | { note_id: number; content_hash: string }
      | undefined;
  }
  saveOutput(key: string, id: number, contentHash: string) {
    this.db.prepare('INSERT OR REPLACE INTO outputs VALUES (?,?,?)').run(key, id, contentHash);
  }
  status() {
    return {
      lastDiscovery: this.get('lastDiscovery'),
      lastError: this.get('lastError'),
      work: this.db.prepare('SELECT status,COUNT(*) AS count FROM work GROUP BY status').all(),
      usage: this.usage(),
      lastRun: this.db.prepare('SELECT report FROM runs ORDER BY created DESC LIMIT 1').get(),
    };
  }
  hasFailures() {
    return (
      Number(
        (
          this.db.prepare("SELECT COUNT(*) AS count FROM work WHERE status='failed'").get() as {
            count: number;
          }
        ).count,
      ) > 0
    );
  }
  prune(days: number) {
    const cutoff = Date.now() - days * 86400000;
    this.db.prepare('DELETE FROM runs WHERE created<?').run(cutoff);
    this.db.prepare("DELETE FROM work WHERE status='done' AND last_seen<?").run(cutoff);
    this.db.prepare('DELETE FROM cooldowns WHERE until_ms<?').run(Date.now());
    this.db
      .prepare('DELETE FROM usage WHERE day<?')
      .run(new Date(cutoff).toISOString().slice(0, 10));
  }
  close() {
    this.db.close();
  }
}
