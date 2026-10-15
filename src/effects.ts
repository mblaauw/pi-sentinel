import type { ProposedAction, EffectReceipt, RunReport } from './contracts.js';
import type { Resolved } from './config.js';
import { State } from './state.js';
import { KubernetesAdapter, type KubeObject } from './adapters/kubernetes.js';
import { HttpClient, ApiError } from './http.js';
import { hash, sleep } from './util.js';
import { noteBody } from './report.js';

export async function repair(
  r: Resolved,
  state: State,
  a: ProposedAction,
  source: { namespace: string; owner: string; ownerUid: string; pod?: string },
  s: AbortSignal,
  preview = false,
): Promise<EffectReceipt> {
  const denied = (detail: string): EffectReceipt => ({ status: 'skipped', detail });
  if (r.task.actions.mode === 'report') return denied('Task is in report mode');
  if (!r.task.actions.allowedPlaybooks.includes(a.playbook))
    return denied('Playbook is not enabled');
  if (a.namespace !== source.namespace || a.name !== source.owner || a.uid !== source.ownerUid)
    return denied('Action target does not match the claimed evidence');
  if (!r.task.scope.namespaces.includes(a.namespace)) return denied('Namespace is outside scope');
  if (
    r.task.scope.deployments.length &&
    !r.task.scope.deployments.includes(`${a.namespace}/${a.name}`)
  )
    return denied('Deployment is outside the task deployment allowlist');
  const conn = r.platform.connections[r.task.connection]!;
  if (!conn.writableDeployments.includes(`${a.namespace}/${a.name}`))
    return denied('Deployment is not in the connection write allowlist');
  if (preview || r.task.actions.mode === 'propose')
    return { status: 'proposed', detail: `Would run ${a.playbook} on ${a.namespace}/${a.name}` };
  if (!r.platform.policy.allowAuto) return denied('Environment does not allow auto repair');
  const kube = new KubernetesAdapter(r),
    targetKey = `${a.namespace}/${a.name}/${a.uid}`;
  const key = hash({
    playbook: a.playbook,
    targetKey,
    sourceRevision: state.item(`${a.namespace}/pod/${source.pod}`)?.revision ?? source,
  });
  const existing = state.effect(key);
  if (existing?.receipt) return existing.receipt;
  if (!existing && state.cooldown(targetKey)) return denied('Owner cooldown is active');
  let deployment = await kube.get(a.namespace, 'deployments', a.name, s);
  if (deployment.metadata.uid !== a.uid) return denied('Target UID changed');
  const eligible = (d: KubeObject) =>
    d.metadata.annotations?.['pi-sentinel/auto-repair'] === 'true' &&
    (d.spec?.replicas ?? 0) >= 2 &&
    d.spec?.strategy?.type !== 'Recreate' &&
    !d.spec?.paused &&
    !(d.spec?.template?.spec?.volumes ?? []).some((v: any) => v.persistentVolumeClaim);
  if (!eligible(deployment))
    return denied('Deployment is not opted-in, stateless, replicated and rollable');
  const rolling = deployment.spec?.strategy?.rollingUpdate ?? {},
    replicas = deployment.spec.replicas;
  const percentage = (value: unknown, round: (x: number) => number) =>
    typeof value === 'string' && value.endsWith('%')
      ? round((replicas * Number(value.slice(0, -1))) / 100)
      : Number(value);
  if (
    percentage(rolling.maxUnavailable ?? '25%', Math.floor) !== 0 ||
    percentage(rolling.maxSurge ?? '25%', Math.ceil) < 1
  )
    return denied('Repair requires zero rollout unavailability and positive surge');
  if (
    !existing &&
    ((deployment.status?.availableReplicas ?? 0) < 1 ||
      (deployment.status?.observedGeneration ?? 0) < (deployment.metadata.generation ?? 0))
  )
    return denied('Deployment availability or observed generation is insufficient');
  const annotation = existing?.intent.annotation ?? new Date().toISOString();
  const intent = { annotation, uid: a.uid, namespace: a.namespace, name: a.name };
  state.intent(key, intent);
  state.setCooldown(targetKey, r.task.actions.cooldownSeconds);
  const current = deployment.spec?.template?.metadata?.annotations?.['pi-sentinel/restarted-at'];
  if (current !== annotation) {
    if (existing)
      return {
        status: 'uncertain',
        detail: 'Unfinished restart intent does not match target; no automatic repeat',
        verified: false,
      };
    const annotations = {
      ...(deployment.spec?.template?.metadata?.annotations ?? {}),
      'pi-sentinel/restarted-at': annotation,
    };
    const patch = [
      { op: 'test', path: '/metadata/uid', value: a.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: deployment.metadata.resourceVersion },
      { op: 'add', path: '/spec/template/metadata/annotations', value: annotations },
    ];
    try {
      await kube.client.request(
        `/apis/apps/v1/namespaces/${kube.ns(a.namespace)}/deployments/${encodeURIComponent(a.name)}`,
        s,
        'PATCH',
        patch,
        undefined,
        false,
        'application/json-patch+json',
      );
    } catch (e) {
      const receipt: EffectReceipt = {
        status: 'uncertain',
        detail: 'Restart write outcome requires reconciliation: ' + String(e),
        verified: false,
      };
      return receipt;
    }
  }
  while (!s.aborted) {
    deployment = await kube.get(a.namespace, 'deployments', a.name, s);
    if (deployment.metadata.uid !== a.uid) break;
    const n = deployment.spec?.replicas ?? 0;
    if (
      (deployment.status?.observedGeneration ?? 0) >= (deployment.metadata.generation ?? 0) &&
      deployment.status?.updatedReplicas === n &&
      deployment.status?.availableReplicas === n &&
      (deployment.status?.replicas ?? 0) === n
    ) {
      const receipt: EffectReceipt = {
        status: 'executed',
        detail: `Restarted ${a.namespace}/${a.name}; rollout available`,
        verified: true,
      };
      state.receipt(key, receipt);
      return receipt;
    }
    await sleep(2000, s);
  }
  const receipt: EffectReceipt = {
    status: 'uncertain',
    detail: 'Restart was requested; rollout verification did not complete',
    verified: false,
  };
  state.receipt(key, receipt);
  return receipt;
}

interface RemoteNote {
  id: number;
  body: string;
  author: { id: number };
}
export async function publish(
  r: Resolved,
  state: State,
  report: RunReport,
  s: AbortSignal,
): Promise<EffectReceipt> {
  if (report.preview || !r.task.output.publish || r.task.output.type === 'stdout')
    return { status: 'skipped', detail: 'External publication disabled' };
  const connection = r.platform.connections[r.task.output.connection ?? r.task.connection]!;
  const client = new HttpClient(connection),
    user = (await client.request<{ id: number }>('/user', s)).data;
  if (connection.botUserId && user.id !== connection.botUserId)
    throw new Error('Publishing credential is not the configured bot');
  let project = r.task.output.projectPath,
    iid = r.task.output.issueIid;
  if (r.task.output.type === 'gitlab.item-note') {
    const match = /^(.+)#(\d+)$/.exec(report.sourceId);
    if (!match) throw new Error('Invalid note source');
    project = match[1];
    iid = Number(match[2]);
  }
  if (!project || !iid || !connection.allowedProjects.includes(project))
    throw new Error('Output target is outside allowed projects');
  const key = `${r.task.id}:${r.environment}:${project}#${iid}`,
    marker = `<!-- pi-sentinel:${key} -->`;
  const body = marker + '\n' + noteBody(report);
  // Exclude timestamps, run IDs and generated footer from the no-change identity.
  const contentHash = hash({
    result: report.result,
    coverage: report.coverage,
    missing: report.missing,
    effects: report.effects,
  });
  if (state.output(key)?.content_hash === contentHash)
    return { status: 'skipped', detail: 'Equivalent report already published' };
  const base = `/projects/${encodeURIComponent(project)}/issues/${iid}/notes`;
  const notes = await client.pages<RemoteNote>(base, s);
  const owned = notes.find((n) => n.author.id === user.id && n.body.startsWith(marker));
  const remote = owned
    ? await client.request<RemoteNote>(`${base}/${owned.id}`, s, 'PUT', { body })
    : await client.request<RemoteNote>(base, s, 'POST', { body });
  state.saveOutput(key, remote.data.id, contentHash);
  return {
    status: 'executed',
    detail: `${owned ? 'Updated' : 'Created'} bot note ${remote.data.id}`,
  };
}
