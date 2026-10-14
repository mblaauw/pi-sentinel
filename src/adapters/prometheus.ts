import type { Adapter, Evidence, Tool } from '../contracts.js';
import type { Resolved } from '../config.js';
import { HttpClient } from '../http.js';
import { hash } from '../util.js';

function localDate(date: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return `${p.find((p) => p.type === 'year')!.value}-${p.find((p) => p.type === 'month')!.value}-${p.find((p) => p.type === 'day')!.value}`;
}
export function midnight(day: string, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number),
    target = Date.UTC(y!, m! - 1, d!);
  let guess = target;
  for (let n = 0; n < 5; n++) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const actual = Date.UTC(
      v('year'),
      v('month') - 1,
      v('day'),
      v('hour'),
      v('minute'),
      v('second'),
    );
    guess += target - actual;
  }
  return guess;
}
export function reportWindows(
  now: Date,
  timeZone: string,
  type: 'previous-day' | 'last-hour',
  count: number,
) {
  const end =
    type === 'last-hour'
      ? Math.floor(now.getTime() / 3600000) * 3600000
      : midnight(localDate(now, timeZone), timeZone);
  const result: Array<{ start: number; end: number; key: string }> = [];
  let cursor = end;
  for (let n = 0; n < count; n++) {
    const start =
      type === 'last-hour'
        ? cursor - 3600000
        : midnight(localDate(new Date(cursor - 12 * 3600000), timeZone), timeZone);
    result.push({ start, end: cursor, key: `${type}:${new Date(start).toISOString()}` });
    cursor = start;
  }
  return result.reverse();
}
export class PrometheusAdapter implements Adapter {
  readonly client: HttpClient;
  constructor(
    readonly resolved: Resolved,
    preview = false,
  ) {
    this.client = new HttpClient(resolved.platform.connections[resolved.task.connection]!, preview);
  }
  async *discover(s: AbortSignal) {
    for (const w of reportWindows(
      new Date(),
      this.resolved.task.trigger.timeZone,
      this.resolved.task.report.window,
      this.resolved.task.report.catchUpWindows,
    ))
      yield await this.gather(w, s);
  }
  async gather(
    window: { start: number; end: number; key: string },
    s: AbortSignal,
  ): Promise<Evidence> {
    const refs: Record<string, unknown> = {},
      missing: string[] = [];
    for (const [name, query] of Object.entries(this.resolved.task.report.queries)) {
      try {
        const q = new URLSearchParams({
          query,
          start: String(window.start / 1000),
          end: String(window.end / 1000),
          step: String(Math.max(60, Math.ceil((window.end - window.start) / 1000 / 240))),
        });
        const data = (
          await this.client.request<{ status: string; data: unknown }>(
            `/api/v1/query_range?${q}`,
            s,
          )
        ).data;
        if (data.status !== 'success') throw new Error('Prometheus did not return success');
        const text = JSON.stringify(data.data);
        if (Buffer.byteLength(text) > this.resolved.task.evidence.maxBytes) {
          missing.push(name + ':truncated');
          refs[name] = { excerpt: text.slice(0, this.resolved.task.evidence.maxBytes) };
        } else refs[name] = data.data;
      } catch (e) {
        missing.push(name + ':' + String(e));
      }
    }
    if (!Object.keys(this.resolved.task.report.queries).length)
      throw new Error('Report recipe requires configured queries');
    if (!Object.keys(refs).length)
      throw new Error('No configured monitoring query returned evidence');
    return {
      id: window.key,
      revision: hash({ window, refs, missing }),
      observedAt: new Date().toISOString(),
      refs,
      missing,
      coverage: missing.length ? 'partial' : 'complete',
      data: { window, timeZone: this.resolved.task.trigger.timeZone },
    };
  }
  async refresh(item: Evidence, s: AbortSignal) {
    return this.gather((item.data as any).window, s);
  }
  tools(item: Evidence): Tool[] {
    return [
      {
        name: 'query_metrics',
        description: 'Read a named monitoring result from this reporting window.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        execute: async (a) => {
          if (!Object.hasOwn(item.refs, String(a.name)))
            throw new Error('Unknown configured query');
          return item.refs[String(a.name)];
        },
      },
    ];
  }
}
