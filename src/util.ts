import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');
export async function safeRead(root: string, name: string): Promise<string> {
  const base = await realpath(root),
    target = await realpath(resolve(base, name));
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`Resource escapes task directory: ${name}`);
  const text = await readFile(target, 'utf8');
  if (Buffer.byteLength(text) > 256000) throw new Error(`Resource too large: ${name}`);
  return text;
}
export async function atomicWrite(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}
export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done();
    const abort = () => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      done();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
export function log(event: string, data: Record<string, unknown> = {}) {
  process.stdout.write(
    redact(JSON.stringify({ time: new Date().toISOString(), event, ...data })) + '\n',
  );
}
export function redact(text: string): string {
  return text
    .replace(
      /("(?:authorization|password|secret|api[_-]?key|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(authorization|password|secret|api[_-]?key|token)(\s*[:=]\s*)([^\s,;"'\\{}\[\]]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer [REDACTED]');
}
