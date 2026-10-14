# Contributing

Use Node 24 and `npm ci --ignore-scripts`. Run `npm run check`, regenerate schemas
with `npm run schemas`, and lint/render all chart modes before opening a change.
Keep examples generic and free of credentials, personal details and internal URLs.

Use Conventional Commits with a concise imperative subject, for example
`feat(gitlab): gather linked refinement context`. Keep commits focused and inspect
the staged diff before committing. Describe the resulting behavior, why it
matters and relevant validation in pull requests.

Runtime changes need meaningful tests at the adapter/contract boundary. Never
replace scope checks with prompt instructions. New mutation playbooks need target
preconditions, durable intent, timeout reconciliation and verified outcomes.

Chart changes update `Chart.yaml` and the chart changelog together. Values must
retain non-root execution, resource limits, explicit egress and Secret references.
Changes requiring new binaries/dependencies belong in a runtime release rather
than runtime package installation.

Do not publish captured private evidence as a fixture. Redact and minimize it
first, and clearly separate contract assertions from human quality evaluation.
