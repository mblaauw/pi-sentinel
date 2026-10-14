import type { Adapter, Evidence, Tool } from '../contracts.js';
import type { Resolved } from '../config.js';
import { HttpClient } from '../http.js';
import { hash, redact } from '../util.js';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
interface Issue {
  project_id?: number;
  iid: number;
  id: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
  epic?: { group_id: number; iid: number };
}
interface Note {
  id: number;
  body: string;
  author: { id: number };
  system: boolean;
}
export class GitLabAdapter implements Adapter {
  readonly client: HttpClient;
  private bot?: number;
  constructor(
    readonly resolved: Resolved,
    preview = false,
  ) {
    this.client = new HttpClient(resolved.platform.connections[resolved.task.connection]!, preview);
  }
  async botId(signal: AbortSignal) {
    return (this.bot ??=
      this.client.config.botUserId ??
      (await this.client.request<{ id: number }>('/user', signal)).data.id);
  }
  allowed(project: string) {
    if (!this.resolved.task.scope.projects.includes(project))
      throw new Error(`Project outside task scope: ${project}`);
  }
  issuePath(project: string, iid: number) {
    this.allowed(project);
    if (!Number.isSafeInteger(iid) || iid < 1) throw new Error('Invalid issue IID');
    return `/projects/${encodeURIComponent(project)}/issues/${iid}`;
  }
  async getIssue(project: string, iid: number, signal: AbortSignal) {
    return (await this.client.request<Issue>(this.issuePath(project, iid), signal)).data;
  }
  async notes(project: string, iid: number, signal: AbortSignal) {
    const bot = await this.botId(signal);
    return (await this.client.pages<Note>(this.issuePath(project, iid) + '/notes', signal))
      .filter((n) => !n.system && n.author.id !== bot)
      .map((n) => ({ id: n.id, body: n.body, author: n.author.id }));
  }
  parse(id: string) {
    const match = /^(.+)#([1-9]\d*)$/.exec(id);
    if (!match) throw new Error('Expected project/path#IID');
    return { project: match[1]!, iid: Number(match[2]) };
  }
  async *discover(signal: AbortSignal): AsyncIterable<Evidence> {
    for (const project of this.resolved.task.scope.projects) {
      const query = new URLSearchParams({
        state: 'opened',
        scope: 'all',
        labels: this.resolved.task.scope.labels.join(','),
      });
      const issues = await this.client.pages<Issue>(
        `/projects/${encodeURIComponent(project)}/issues?${query}`,
        signal,
      );
      for (const issue of issues) {
        signal.throwIfAborted();
        yield await this.gather(project, issue.iid, signal);
      }
    }
  }
  fingerprint(item: Evidence) {
    item.revision = hash({
      refs: item.refs,
      missing: item.missing.map((m) => m.split(':')[0]),
      eligible: (item.data as any).eligible,
    });
  }
  async refresh(item: Evidence, signal: AbortSignal) {
    const p = this.parse(item.id),
      fresh = await this.gather(p.project, p.iid, signal);
    for (const value of Object.values(item.refs)) {
      const repo = (value as any)?.repository;
      if (
        repo &&
        typeof repo.project === 'string' &&
        typeof repo.path === 'string' &&
        typeof repo.ref === 'string'
      ) {
        try {
          await this.repositoryFile(fresh, repo.project, repo.path, repo.ref, signal);
        } catch (e) {
          fresh.coverage = 'partial';
          fresh.missing.push('repository:' + String(e));
        }
      }
    }
    this.fingerprint(fresh);
    return fresh;
  }
  async repositoryFile(item: Evidence, project: string, path: string, ref: string, s: AbortSignal) {
    this.allowed(project);
    if (path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('Invalid repository path');
    const id = `${project}:${path}@${ref}`;
    if (
      !Object.hasOwn(item.refs, id) &&
      Object.keys(item.refs).length >= this.resolved.task.evidence.maxRefs
    )
      throw new Error('Reference budget exhausted');
    const r = (
      await this.client.request<{ content: string; encoding: string }>(
        `/projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
        s,
      )
    ).data;
    const text =
      r.encoding === 'base64' ? Buffer.from(r.content, 'base64').toString('utf8') : r.content;
    const cap = this.resolved.task.evidence.maxBytes;
    item.refs[id] = {
      repository: { project, path, ref },
      text: redact(text.slice(0, cap)),
      truncated: text.length > cap,
    };
    if (text.length > cap) {
      item.coverage = 'partial';
      item.missing.push(id + ':truncated');
    }
    this.fingerprint(item);
    return item.refs[id];
  }
  async gather(project: string, iid: number, signal: AbortSignal): Promise<Evidence> {
    const root = await this.getIssue(project, iid, signal);
    const notes = await this.notes(project, iid, signal),
      refs: Record<string, unknown> = {},
      missing: string[] = [];
    let bytes = 0;
    const add = (id: string, data: unknown) => {
      const text = redact(JSON.stringify(data));
      const cap = this.resolved.task.evidence.maxBytes;
      if (
        Buffer.byteLength(text) > cap ||
        bytes + Buffer.byteLength(text) > this.resolved.task.evidence.maxTotalBytes
      ) {
        refs[id] = {
          excerpt: text.slice(
            0,
            Math.min(cap, Math.max(0, this.resolved.task.evidence.maxTotalBytes - bytes)),
          ),
          truncated: true,
        };
        missing.push(id + ':truncated');
        bytes += Buffer.byteLength(JSON.stringify(refs[id]));
      } else {
        refs[id] = JSON.parse(text);
        bytes += Buffer.byteLength(text);
      }
    };
    add(`${project}#${iid}`, {
      title: root.title,
      description: root.description,
      labels: root.labels,
      state: root.state,
      url: root.web_url,
      notes,
    });
    const queue: Array<{ project: string; iid: number; depth: number }> = [];
    const enqueue = (text: string, p: string, depth: number) => {
      for (const m of text.matchAll(/(?:(\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+))?#([1-9]\d*)\b/g))
        queue.push({ project: m[1] ?? p, iid: Number(m[2]), depth });
    };
    enqueue(root.description ?? '', project, 1);
    for (const note of notes) enqueue(note.body, project, 1);
    try {
      const linked = await this.client.pages<{
        project_id: number;
        iid: number;
        references?: { full: string };
        web_url?: string;
      }>(this.issuePath(project, iid) + '/links', signal);
      for (const l of linked) {
        if (l.references?.full) {
          enqueue(l.references.full, project, 1);
          continue;
        }
        const linkedProject = this.resolved.task.scope.projects.find(
          (p) =>
            l.web_url?.includes('/' + p + '/-/issues/') ||
            l.web_url?.includes('/' + p + '/issues/'),
        );
        if (linkedProject) queue.push({ project: linkedProject, iid: l.iid, depth: 1 });
        else if (l.project_id === root.project_id) queue.push({ project, iid: l.iid, depth: 1 });
        else missing.push(`linked-project-${l.project_id}#${l.iid}:unresolved-or-outside-scope`);
      }
    } catch (e) {
      missing.push('issue-links:' + String(e));
    }
    if (root.epic) {
      try {
        add(
          `epic:${root.epic.group_id}&${root.epic.iid}`,
          (
            await this.client.request(
              `/groups/${root.epic.group_id}/epics/${root.epic.iid}`,
              signal,
            )
          ).data,
        );
      } catch (e) {
        missing.push('parent-epic:' + String(e));
      }
    }
    while (queue.length && Object.keys(refs).length < this.resolved.task.evidence.maxRefs) {
      const next = queue.shift()!,
        id = `${next.project}#${next.iid}`;
      if (refs[id] || next.depth > this.resolved.task.evidence.maxDepth) continue;
      if (!this.resolved.task.scope.projects.includes(next.project)) {
        missing.push(id + ':outside-scope');
        continue;
      }
      try {
        const issue = await this.getIssue(next.project, next.iid, signal);
        add(id, { title: issue.title, description: issue.description, labels: issue.labels });
        enqueue(issue.description ?? '', next.project, next.depth + 1);
      } catch (e) {
        missing.push(id + ':' + String(e));
      }
    }
    if (queue.length) missing.push('reference-limit');
    const data = {
      project,
      iid,
      eligible:
        root.state === 'opened' &&
        this.resolved.task.scope.labels.every((l) => root.labels.includes(l)),
      root: `${project}#${iid}`,
    };
    return {
      id: `${project}#${iid}`,
      revision: hash({
        refs,
        missing: missing.map((m) => m.split(':')[0]),
        eligible: data.eligible,
      }),
      observedAt: new Date().toISOString(),
      refs,
      missing,
      coverage: missing.length ? 'partial' : 'complete',
      data,
    };
  }
  tools(item: Evidence): Tool[] {
    const entry = this.parse(item.id);
    return [
      {
        name: 'get_issue',
        description: 'Read the current source issue.',
        parameters: object({}),
        execute: async (_a, s) => this.getIssue(entry.project, entry.iid, s),
      },
      {
        name: 'get_issue_notes',
        description: 'Read human discussion, excluding bot and system notes.',
        parameters: object({}),
        execute: async (_a, s) => this.notes(entry.project, entry.iid, s),
      },
      {
        name: 'get_linked_issue',
        description: 'Read an issue already included in the bounded evidence references.',
        parameters: object({ ref: { type: 'string' } }, ['ref']),
        execute: async (a) => {
          const ref = String(a.ref);
          if (!Object.hasOwn(item.refs, ref))
            throw new Error('Reference was not collected within scope');
          return item.refs[ref];
        },
      },
      {
        name: 'get_repository_file',
        description:
          'Read a bounded repository file from an allowed project and explicit Git reference. Cite its returned project:path@ref identity.',
        parameters: object(
          { project: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
          ['project', 'path', 'ref'],
        ),
        execute: async (a, s) =>
          this.repositoryFile(item, String(a.project), String(a.path), String(a.ref), s),
      },
    ];
  }
}
