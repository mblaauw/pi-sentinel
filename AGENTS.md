# Sentinel Pi contributor instructions

Read README.md, DESIGN.md and TASK_AUTHORING.md before changing task semantics.

- Runtime: Node 24, TypeScript, pinned Pi SDK. Keep all dependency changes locked.
- Run `npm run check` and `npm run format:check`; regenerate JSON schemas after
  changing a contract and update example task locks after changing behavior.
- Domain tools read bounded evidence. Operational mutations go through reviewed
  playbooks with durable intents, scope checks and outcome verification.
- Model-visible tools must remain explicit. Do not restore default shell/edit
  tools or discover ambient Pi/OpenCode configuration in a worker.
- Preview must use separate state and non-publishing adapters. Custom TypeScript
  is trusted code, not a sandbox, and needs normal code review.
- Helm changes retain scoped identity, non-root execution, resources, explicit
  egress, immutable task references and PVC retention. Bump chart/changelog together.
- Public files use generic placeholders. Do not commit real tokens, internal
  platform endpoints, captured private evidence or source-reference archives.
- Use focused Conventional Commits; review the staged delta before committing.
- Describe actual verification and remaining limits. Mock integration success is
  not a claim of live model quality, container build or cluster acceptance.
