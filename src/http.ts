import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import type { Connection } from './contracts.js';
import { redact } from './util.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}
export class HttpClient {
  constructor(
    readonly config: Connection,
    readonly preview = false,
  ) {}
  async request<T>(
    path: string,
    signal: AbortSignal,
    method = 'GET',
    body?: unknown,
    tokenOverride?: string,
    text = false,
    contentType = 'application/json',
  ): Promise<{ data: T; headers: http.IncomingHttpHeaders }> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..'))
      throw new Error('API path must stay within the configured endpoint');
    if (this.preview && method !== 'GET') throw new Error('Preview client cannot mutate');
    const url = new URL(this.config.baseUrl.replace(/\/$/, '') + path);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid API endpoint');
    const tokenName = this.preview ? this.config.readTokenEnv : this.config.tokenEnv;
    let token = tokenOverride ?? (tokenName ? process.env[tokenName] : undefined);
    if (this.preview && this.config.kind === 'gitlab' && !tokenName)
      throw new Error('Live GitLab preview requires a separate readTokenEnv connection');
    if (this.config.tokenFile) token = (await readFile(this.config.tokenFile, 'utf8')).trim();
    if (tokenName && !token)
      throw new Error(`Missing credential environment variable '${tokenName}'`);
    const ca = this.config.caFile ? await readFile(this.config.caFile) : undefined;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token)
      headers[this.config.kind === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization'] =
        this.config.kind === 'gitlab' ? token : 'Bearer ' + token;
    if (payload) {
      headers['content-type'] = contentType;
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    return new Promise((done, fail) => {
      const req = (url.protocol === 'https:' ? https.request : http.request)(
        url,
        { method, headers, signal, timeout: 20000, ...(ca ? { ca } : {}) },
        (res) => {
          let raw = '',
            size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000) req.destroy(new Error('API response exceeds 2 MB limit'));
            else raw += chunk.toString();
          });
          res.on('error', fail);
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300)
              return fail(
                new ApiError(
                  status,
                  status === 404
                    ? 'not_found'
                    : status === 401 || status === 403
                      ? 'not_authorized'
                      : status === 429
                        ? 'rate_limited'
                        : 'unavailable',
                  `API ${method} returned ${status}: ${redact(raw.slice(0, 200))}`,
                ),
              );
            try {
              done({ data: text ? raw : raw ? JSON.parse(raw) : null, headers: res.headers });
            } catch {
              fail(new Error('API returned invalid JSON'));
            }
          });
        },
      );
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('API request timed out')));
      if (payload) req.write(payload);
      req.end();
    });
  }
  async pages<T>(path: string, signal: AbortSignal, maxPages = 50): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.request<T[]>(
        path + (path.includes('?') ? '&' : '?') + `per_page=100&page=${page}`,
        signal,
      );
      if (!Array.isArray(r.data)) throw new Error('Expected paginated array');
      all.push(...r.data);
      const next = r.headers['x-next-page'];
      if (next === '' || (next === undefined && r.data.length < 100)) return all;
      if (page === maxPages) throw new Error('Pagination cap reached; discovery is incomplete');
    }
    return all;
  }
}
