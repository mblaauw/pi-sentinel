import type { Adapter, Evidence, Tool } from '../contracts.js';
import type { Resolved } from '../config.js';
import { HttpClient } from '../http.js';
import { hash } from '../util.js';
export interface KubeObject {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    resourceVersion?: string;
    generation?: number;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{ kind: string; name: string; uid: string }>;
  };
  spec?: any;
  status?: any;
}
export class KubernetesAdapter implements Adapter {
  readonly client: HttpClient;
  constructor(
    readonly resolved: Resolved,
    preview = false,
  ) {
    this.client = new HttpClient(resolved.platform.connections[resolved.task.connection]!, preview);
  }
  ns(namespace: string) {
    if (!this.resolved.task.scope.namespaces.includes(namespace))
      throw new Error('Namespace outside task scope');
    return encodeURIComponent(namespace);
  }
  async get(
    namespace: string,
    resource: string,
    name: string,
    s: AbortSignal,
  ): Promise<KubeObject> {
    if (!['pods', 'deployments', 'replicasets'].includes(resource) || !name || name.includes('/'))
      throw new Error('Unsupported object');
    const group = resource === 'pods' ? '/api/v1' : '/apis/apps/v1';
    return (
      await this.client.request<KubeObject>(
        `${group}/namespaces/${this.ns(namespace)}/${resource}/${encodeURIComponent(name)}`,
        s,
      )
    ).data;
  }
  async owner(pod: KubeObject, s: AbortSignal) {
    const ns = pod.metadata.namespace!,
      owner = pod.metadata.ownerReferences?.[0];
    if (!owner) return pod;
    if (owner.kind === 'ReplicaSet') {
      const rs = await this.get(ns, 'replicasets', owner.name, s);
      const d = rs.metadata.ownerReferences?.[0];
      return d?.kind === 'Deployment' ? this.get(ns, 'deployments', d.name, s) : rs;
    }
    return pod;
  }
  async *discover(s: AbortSignal): AsyncIterable<Evidence> {
    for (const ns of this.resolved.task.scope.namespaces) {
      let cont = '';
      do {
        const r = (
          await this.client.request<{ items: KubeObject[]; metadata: { continue?: string } }>(
            `/api/v1/namespaces/${this.ns(ns)}/pods?limit=200&continue=${encodeURIComponent(cont)}`,
            s,
          )
        ).data;
        for (const pod of r.items) {
          if (this.failed(pod)) yield await this.gather(ns, pod.metadata.name, s);
          else if (
            pod.status?.phase === 'Running' &&
            (pod.status?.conditions ?? []).some(
              (c: any) => c.type === 'Ready' && c.status === 'True',
            )
          ) {
            const id = `${ns}/pod/${pod.metadata.name}`;
            yield {
              id,
              revision: hash({ uid: pod.metadata.uid, ready: true }),
              observedAt: new Date().toISOString(),
              refs: { [id]: { ready: true, uid: pod.metadata.uid } },
              coverage: 'complete',
              missing: [],
              data: { namespace: ns, pod: pod.metadata.name, eligible: false, recovered: true },
            };
          }
        }
        cont = r.metadata.continue ?? '';
      } while (cont);
    }
  }
  failed(pod: KubeObject) {
    return (
      pod.status?.phase === 'Failed' ||
      (pod.status?.containerStatuses ?? []).some(
        (c: any) =>
          c.state?.waiting &&
          [
            'CrashLoopBackOff',
            'ImagePullBackOff',
            'ErrImagePull',
            'CreateContainerConfigError',
          ].includes(c.state.waiting.reason),
      )
    );
  }
  async gather(ns: string, name: string, s: AbortSignal): Promise<Evidence> {
    const pod = await this.get(ns, 'pods', name, s),
      refs: Record<string, unknown> = {},
      missing: string[] = [];
    let owner = pod;
    try {
      owner = await this.owner(pod, s);
    } catch (e) {
      missing.push('owner:' + String(e));
    }
    const podRef = `${ns}/pod/${name}`,
      ownerRef = `${ns}/${owner.spec?.template ? 'deployment' : 'owner'}/${owner.metadata.name}`;
    // Never expose pod specs: they may contain literal credentials in env/args.
    refs[podRef] = { metadata: { name, namespace: ns, uid: pod.metadata.uid }, status: pod.status };
    refs[ownerRef] = {
      metadata: { name: owner.metadata.name, namespace: ns, uid: owner.metadata.uid },
      replicas: owner.spec?.replicas,
      status: owner.status,
    };
    try {
      refs[`${ns}/events`] = (
        await this.client.request<{ items: unknown[] }>(
          `/api/v1/namespaces/${this.ns(ns)}/events?fieldSelector=involvedObject.uid%3D${encodeURIComponent(pod.metadata.uid)}`,
          s,
        )
      ).data.items.slice(-30);
    } catch (e) {
      missing.push('events:' + String(e));
    }
    const normalized = {
      failure: this.failed(pod),
      ownerUid: owner.metadata.uid,
      containers: (pod.status?.containerStatuses ?? []).map((c: any) => ({
        name: c.name,
        ready: c.ready,
        reason: c.state?.waiting?.reason,
        exitCode: c.lastState?.terminated?.exitCode,
      })),
      phase: pod.status?.phase,
    };
    return {
      id: podRef,
      revision: hash(normalized),
      observedAt: new Date().toISOString(),
      refs,
      coverage: missing.length ? 'partial' : 'complete',
      missing,
      data: {
        namespace: ns,
        pod: name,
        owner: owner.metadata.name,
        ownerUid: owner.metadata.uid,
        eligible: this.failed(pod),
      },
    };
  }
  async refresh(item: Evidence, s: AbortSignal) {
    const d = item.data as any;
    return this.gather(d.namespace, d.pod, s);
  }
  tools(item: Evidence): Tool[] {
    const d = item.data as any;
    return [
      {
        name: 'get_pod_status',
        description: 'Read the collected pod status.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => item.refs[item.id],
      },
      {
        name: 'get_owner_status',
        description: 'Read collected owner status and identity.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () =>
          Object.fromEntries(
            Object.entries(item.refs).filter(
              ([k]) => k.includes('/deployment/') || k.includes('/owner/'),
            ),
          ),
      },
      {
        name: 'get_namespace_events',
        description: 'Read relevant collected events.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => item.refs[d.namespace + '/events'],
      },
      {
        name: 'get_pod_logs',
        description: 'Read a bounded excerpt of current or previous container logs.',
        parameters: {
          type: 'object',
          properties: { container: { type: 'string' }, previous: { type: 'boolean' } },
          required: ['container'],
          additionalProperties: false,
        },
        execute: async (a, s) => {
          const container = String(a.container);
          if (!/^[a-z0-9-]+$/.test(container)) throw new Error('Invalid container');
          // The API returns text; fetch through the log-specific reader.
          const { readLog } = await import('../log-reader.js');
          const text = await readLog(
            this.client,
            `/api/v1/namespaces/${this.ns(d.namespace)}/pods/${encodeURIComponent(d.pod)}/log?container=${encodeURIComponent(container)}&previous=${a.previous === true}&tailLines=${this.resolved.task.evidence.maxLogLines}&limitBytes=${this.resolved.task.evidence.maxBytes}`,
            s,
          );
          const ref = item.id + '/logs/' + container;
          item.refs[ref] = { text };
          return item.refs[ref];
        },
      },
    ];
  }
}
