# Sentinel Pi

**Small autonomous workers. One image. Tasks as code.**

Sentinel Pi runs bounded Pi agent sessions on Kubernetes, connected to your own
OpenAI-compatible model router. Define a task, inspect its scope, preview its
output and deploy through a shared Helm chart.

The runtime is implemented in TypeScript on Node 24. It includes a task CLI,
three recipes, SQLite state, previews, reports and Kubernetes packaging. Its
integration tests use local mock APIs and the real pinned Pi SDK. A real model,
container build and cluster deployment must be verified in your environment.

## What it does

| Recipe                | Behavior                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `gitlab-refinement@1` | Find labeled issues, gather linked context and draft or publish contextual refinement questions       |
| `kubernetes-care@1`   | Diagnose sustained pod failures, report recovery and optionally execute one approved restart playbook |
| `platform-report@1`   | Explain monitoring results for completed hourly/daily windows, with bounded catch-up                  |

Continuous tasks use a singleton Deployment. Scheduled tasks use a CronJob. One-off
tasks use a Job. Each task release has its own state and access. Empty or unchanged
polls do not invoke the model.

## Quick start

Requirements: Node **24+**, npm, and a Linux environment with `flock` for persistent
workers. Helm **3.19+** and Kubernetes **1.27+** are needed for deployment. Authoring
and previews also run on macOS; persistent workers target Linux containers.

```bash
npm ci --ignore-scripts
npm run check
node dist/cli.js --help

# Existing generic examples have reviewed lockfiles.
node dist/cli.js task validate examples/tasks/refinement-review --environment tst
node dist/cli.js task explain examples/tasks/refinement-review --environment tst

# No network and no inference: validate the recorded fixture.
node dist/cli.js task preview examples/tasks/refinement-review \
  --fixture fixtures/missing-criteria.json --check-only
```

Configure `examples/environments/tst.yaml` with your router and source endpoints,
then update the lockfile deliberately. Set the referenced credentials through your
environment or Kubernetes Secrets. No credential values belong in task files.

```bash
node dist/cli.js task resolve examples/tasks/refinement-review \
  --environment tst --write-lock

# Recorded source data, real inference, no publication or repairs.
node dist/cli.js task preview examples/tasks/refinement-review \
  --fixture fixtures/missing-criteria.json --out artifacts/preview
```

Open `artifacts/preview/report.html` or `report.md`. The JSON artifact contains the
same structured result and run metadata. Recorded inputs do not imply identical
model wording across repeated runs.

## Create another task

```bash
node dist/cli.js task init my-review --recipe gitlab-refinement --root .
# Set scope and provision environments/tst.yaml.
node dist/cli.js task resolve tasks/my-review --environment tst --write-lock
node dist/cli.js task validate tasks/my-review --environment tst
node dist/cli.js task explain tasks/my-review --environment tst
```

A task definition stays small:

```yaml
apiVersion: sentinel.pi/v1alpha1
id: refinement-review
owner: platform-team
recipe: gitlab-refinement@1
connection: gitlab
scope:
  projects: [example/platform]
  labels: [technical-refinement]
trigger:
  mode: cron
  schedule: '*/5 * * * *'
  timeZone: Europe/Amsterdam
output:
  language: nl
  publish: false
```

The recipe supplies tools, workflow, standard instructions and bounds. Add
Markdown instructions/skills, a trusted custom `flow.ts`, or a dependency-free
custom read tool when needed. See [TASK_AUTHORING.md](TASK_AUTHORING.md).

## Deploy with Helm

Build the runtime once; task packaging does not rebuild it. Use your internal
registry mirror/base image in an air-gapped installation.

```bash
docker build --tag sentinel-pi:0.1.0 .
node dist/cli.js task package examples/tasks/refinement-review \
  --environment tst --out artifacts/task
```

Set your explicit context/namespace and replace the placeholder image digest,
credential Secret references and egress rules in your environment values.

```bash
kubectl --context "$KUBE_CONTEXT" --namespace "$KUBE_NAMESPACE" \
  apply -f artifacts/task/task-configmap.yaml
helm upgrade --install sentinel-review helm/sentinel-pi \
  --kube-context "$KUBE_CONTEXT" --namespace "$KUBE_NAMESPACE" \
  --values artifacts/task/task-values.yaml --values your-values.yaml --wait
```

The chart defaults to restricted egress and does not assume API/router addresses.
Configure DNS/API destinations for your actual CNI. Cross-namespace RBAC requires
deployment rights in those selected namespaces. Credential Secrets must already
exist, or be provisioned through the optional ExternalSecret configuration.

## Credentials

Environment profiles reference variable names rather than credential values:

| Example variable    | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `VLLM_API_KEY`      | Authentication to your model router                        |
| `GITLAB_TOKEN`      | Production source access and optional bot-note publication |
| `GITLAB_READ_TOKEN` | Separate read-only identity for live preview               |

Kubernetes workers use the mounted dedicated ServiceAccount token and CA. API
clients support a configured CA file; `NODE_EXTRA_CA_CERTS` supplies router TLS
trust. Configure the actual served model ID and context/output limits.

## Development and verification

```bash
npm run check
npm run schemas
helm lint helm/sentinel-pi --set task.configMapName=validation-bundle
```

Tests cover the pinned Pi tool protocol, scopes/lockfiles, no-change processing,
publication recovery, previews, custom flows, repair conditions and timezone/DST
windows. GitHub Actions validates the public project; GitLab CI provides split
validation/build/package stages and a consumer deployment template. Container
publication is manually triggered; no cluster is deployed by the public workflow.

## Operational boundaries

- SQLite on a per-task block-storage PVC; one active worker. Linux `flock` prevents
  accidental overlap, while storage fencing remains the cluster's responsibility.
- Fresh bounded conversations; state and action receipts outlive conversation history.
- Preview uses isolated state and recording outputs. Live GitLab preview requires
  a separate read credential. Trusted custom TypeScript is not OS-sandboxed.
- Only the declared tools are model-visible. No default shell, filesystem editor
  or unrestricted HTTP tool is enabled.
- The restart playbook requires exact target scope, opt-in, stateless replicated
  Deployment, safe rollout settings, cooldown and verified availability.
- Delivery is at least once with reconciliation; remote API writes cannot be
  committed atomically with local state.
- Daily inference ceilings use UTC calendar days and conservative byte-based
  reservations. They are not billing guarantees or tokenizer-exact limits.

See [DESIGN.md](DESIGN.md), [deployment](docs/deployment.md),
[operations](docs/operations.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
