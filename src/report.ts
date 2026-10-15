import type { RunReport } from './contracts.js';
import { atomicWrite, redact } from './util.js';
import { join } from 'node:path';
export function markdown(r: RunReport) {
  const lines = [
    `# ${r.taskId}: ${r.result.status}`,
    r.result.summary,
    '',
    `Source: ${r.sourceId}`,
    `Coverage: ${r.coverage}${r.missing.length ? ' — ' + r.missing.join('; ') : ''}`,
    '',
    ...r.result.findings.map(
      (f) => `- **${f.severity}**: ${f.text} (${f.evidenceRefs.join(', ')})`,
    ),
  ];
  if (r.result.questions.length)
    lines.push('', '## Questions', ...r.result.questions.map((q, i) => `${i + 1}. ${q}`));
  if (r.result.proposedAction)
    lines.push(
      '',
      '## Proposed action',
      `${r.result.proposedAction.playbook}: ${r.result.proposedAction.namespace}/${r.result.proposedAction.name}`,
      r.result.proposedAction.reason,
    );
  if (r.effects.length)
    lines.push(
      '',
      '## Effects',
      ...r.effects.map(
        (e) =>
          `- ${e.status}: ${e.detail}${e.verified === undefined ? '' : ` (verified: ${e.verified})`}`,
      ),
    );
  lines.push(
    '',
    '---',
    `${r.preview ? 'PREVIEW — no publication or repair' : 'Run'} ${r.runId} · ${Math.round(r.durationMs)} ms · ${r.usage.calls} model calls · ${r.usage.known ? r.usage.input + ' input / ' + r.usage.output + ' output tokens' : 'token usage unknown'}`,
    `Observed: ${r.observedAt} · Evidence: ${r.evidenceRevision.slice(0, 12)} · Behavior: ${r.behaviorHash.slice(0, 12)}`,
  );
  return redact(lines.join('\n')) + '\n';
}
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export function html(r: RunReport) {
  const text = (value: string) => escape(redact(value));
  const findings = r.result.findings
    .map(
      (f) =>
        `<article class="finding"><span class="badge ${f.severity}">${text(f.severity)}</span><div><p>${text(f.text)}</p><small>${f.evidenceRefs.map(text).join(' · ')}</small></div></article>`,
    )
    .join('');
  const effects = r.effects
    .map(
      (e) =>
        `<li><span class="badge">${text(e.status)}</span> ${text(e.detail)}${e.verified === undefined ? '' : ` <strong>${e.verified ? 'Verified' : 'Unverified'}</strong>`}</li>`,
    )
    .join('');
  const action = r.result.proposedAction;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${text(r.taskId)} — Pi Sentinel</title><style>
:root{color-scheme:light;--ink:#172b41;--muted:#617287;--line:#dce5ed;--accent:#157a77}
*{box-sizing:border-box}body{margin:0;background:#f3f6f9;color:var(--ink);font:15px/1.6 system-ui,sans-serif}
main{max-width:1040px;margin:auto;padding:32px 24px 64px}.brand{font-size:12px;letter-spacing:.16em;font-weight:750;color:var(--accent);text-transform:uppercase}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}h1{font-size:30px;line-height:1.2;margin:8px 0}h2{font-size:17px;margin:0 0 14px}p{margin:0 0 10px}.sub,small{color:var(--muted);overflow-wrap:anywhere}
.badge{display:inline-block;background:#e5eef4;color:#345269;padding:3px 10px;border-radius:16px;font-size:12px;font-weight:650;white-space:nowrap}.high,.failed{background:#fce2df;color:#a02c24}.medium,.needs_attention,.partial{background:#fff0d5;color:#8d5a07}.healthy,.complete{background:#daf1e8;color:#24664e}
.summary,.card{background:white;border:1px solid var(--line);border-radius:12px;padding:22px;margin:16px 0}.summary{border-top:3px solid var(--accent)}.summary>p{font-size:18px;line-height:1.6}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 4px}.metric{border-left:2px solid var(--line);padding-left:12px}.metric strong{display:block;font-size:18px}.metric small{font-size:12px}
.finding{display:flex;align-items:flex-start;gap:14px;padding:14px 0;border-top:1px solid var(--line)}.finding p{margin:0 0 3px}ol,ul{padding-left:22px;margin:0}li{margin:10px 0}.preview{padding:10px 16px;background:#e5eef8;border-radius:8px;margin-bottom:18px}.missing{background:#fff7e7;border:1px solid #f3d7a0}.footer{font-size:12px;color:var(--muted);margin:22px 0;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}pre{font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2f7;padding:16px;border-radius:8px}
@media(max-width:620px){main{padding:20px 14px}.metrics{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start}h1{font-size:24px}}
</style></head><body><main>
<header><div><div class="brand">Pi Sentinel / task report</div><h1>${text(r.taskId)}</h1><div class="sub">${text(r.sourceId)}</div></div><span class="badge ${text(r.result.status)}">${text(r.result.status.replaceAll('_', ' '))}</span></header>
${r.preview ? '<div class="preview"><strong>Preview.</strong> No publication or repair was executed.</div>' : ''}
<section class="summary"><p>${text(r.result.summary)}</p><div class="metrics"><div class="metric"><strong>${text(r.coverage)}</strong><small>Evidence coverage</small></div><div class="metric"><strong>${r.usage.calls}</strong><small>Model calls</small></div><div class="metric"><strong>${(r.durationMs / 1000).toFixed(1)}s</strong><small>Duration</small></div><div class="metric"><strong>${r.usage.known ? (r.usage.input + r.usage.output).toLocaleString('en') : 'Unknown'}</strong><small>Reported tokens</small></div></div></section>
${r.missing.length ? `<section class="card missing"><h2>Context requiring attention</h2><ul>${r.missing.map((m) => '<li>' + text(m) + '</li>').join('')}</ul></section>` : ''}
<section class="card"><h2>Findings</h2>${findings || '<p class="sub">No material findings were submitted.</p>'}</section>
${r.result.questions.length ? `<section class="card"><h2>Questions to resolve</h2><ol>${r.result.questions.map((q) => '<li>' + text(q) + '</li>').join('')}</ol></section>` : ''}
${action ? `<section class="card"><h2>Proposed action</h2><p><strong>${text(action.playbook)}</strong> · ${text(action.namespace + '/' + action.name)}</p><p>${text(action.reason)}</p></section>` : ''}
${effects ? `<section class="card"><h2>Actions and delivery</h2><ul>${effects}</ul></section>` : ''}
<div class="footer">Observed ${text(r.observedAt)} · Evidence ${text(r.evidenceRevision.slice(0, 12))} · Behavior ${text(r.behaviorHash.slice(0, 12))}<br>Run ${text(r.runId)} · Environment ${text(r.environment)}</div>
<details class="card"><summary>Structured run details</summary><pre>${text(JSON.stringify(r, null, 2))}</pre></details>
</main></body></html>`;
}
export async function writeReport(dir: string, r: RunReport) {
  await atomicWrite(join(dir, 'result.json'), redact(JSON.stringify(r, null, 2)) + '\n');
  await atomicWrite(join(dir, 'report.md'), markdown(r));
  await atomicWrite(join(dir, 'report.html'), html(r));
}
export function noteBody(r: RunReport) {
  // Block GitLab quick actions even when generated as standalone slash lines.
  return markdown(r)
    .split('\n')
    .map((line) => (/^\s*\//.test(line) ? '> ' + line : line))
    .join('\n');
}
