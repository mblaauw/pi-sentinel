# Authoring Sentinel Pi tasks

This guide is for people and existing OpenCode/Pi coding agents. Use the existing
recipes and configuration before adding custom code. Do not invent site-specific
endpoints, credentials or namespaces.

## Task workflow

1. Identify the source, exact scope, trigger, useful output and requested actions.
2. Choose `gitlab-refinement@1`, `kubernetes-care@1` or `platform-report@1`.
3. Write `tasks/<id>/task.yaml` and an optional focused instruction file.
4. Bind provisioned connections/model profiles in `environments/<environment>.yaml`.
5. Run `task resolve --write-lock`, `task validate` and `task explain`.
6. Preview a meaningful fixture, then an explicit live item if needed.
7. Present the effective scope and actual rendered output in the task MR.
8. Package and deploy through the existing shared CI and Helm chart.

Every command below uses `node dist/cli.js` after `npm run build`. The installed
container also exposes `sentinel` as a convenience executable.

```bash
node dist/cli.js task init review --recipe gitlab-refinement
node dist/cli.js task resolve tasks/review --environment tst --write-lock
node dist/cli.js task validate tasks/review --environment tst
node dist/cli.js task explain tasks/review --environment tst
```

The default environment path is `../../environments/<name>.yaml` relative to the
task directory. Use `--platform <file>` to supply an explicit file.

## Instructions and skills

Use `instructions: prompts/review.md` for a supplement to the standard recipe.
Selected `agent.skills` are task-relative files or directories containing
`SKILL.md`. The selected skills are loaded into the bounded system context;
ambient user/repository skills and coding tools are not discovered.

Ask concrete questions grounded in retrieved evidence. Explicitly mark missing
context. For Dutch output, use collegial language with 'we' and 'je'. Avoid
re-asking decisions already answered in accessible linked issues.

## Preview

```bash
node dist/cli.js task preview tasks/review --fixture fixtures/case.json --check-only
node dist/cli.js task preview tasks/review --fixture fixtures/case.json --out artifacts/preview
node dist/cli.js task preview tasks/review --live --item 'example/platform#123'
```

`--check-only` validates recorded evidence without network or inference. A regular
fixture preview invokes the configured model but uses recorded source tools.
Live preview is explicit, requires one source identity, and uses a read-only
connection. Both use in-memory state and cannot publish through normal adapters.

Inspect the actual Markdown/HTML report. Contract checks are deterministic;
question quality requires human review or an explicitly separate evaluator.
Do not claim fixture structure validation establishes review quality.

## Custom workflow

```yaml
flow:
  type: custom
  file: flow.ts
```

Export a default `CustomFlow` from the file, using the host API in
`examples/custom/flow.ts`. Each `ctx.agent.run` creates a fresh session and may
narrow tools. It cannot widen the task allowlist. Item/cycle budgets still apply.
The returned structured result goes through the normal action/publication path.

## Custom tool

List a task-local TypeScript module in `extensions`, and add its name to
`agent.tools` alongside desired built-ins. Export a tool or tool array with a
bounded **read** manifest; see `examples/custom/tool.ts`. Mutations go through
platform-owned playbooks. No runtime npm installation is supported.

Custom code is trusted and has the pod's OS privileges. Review it like runtime
code; helper APIs are not a security sandbox. If a dependency or integration is
missing, state the gap and change the runtime instead of inserting a shell escape.

## Reviewable output

Include purpose/owner, source scope/schedule, effective model/tools/actions,
lockfile changes, fixture results and a rendered preview in the task MR. State
which source context was partial and what remains unverified. A rollout does not
reprocess all unchanged items; backlog replay is explicit maintenance.
