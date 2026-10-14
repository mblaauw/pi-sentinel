import type { HttpClient } from './http.js';
import { redact } from './util.js';
export async function readLog(client: HttpClient, path: string, signal: AbortSignal) {
  return redact(
    (await client.request<string>(path, signal, 'GET', undefined, undefined, true)).data,
  );
}
