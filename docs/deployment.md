# Deployment

## Requirements and bindings

Use Node 24+, the pinned dependencies, Helm 3.19+, Kubernetes 1.27+, a block-storage
class, provisioned Secrets and explicit deployment context/namespace. The runtime
does not install packages or fetch task instructions at startup.

Mirror the Node base image, npm packages, build tooling and application image into
your approved internal sources for air-gapped operation. Supply `NODE_IMAGE` as a
build argument for your maintained base. The public examples intentionally do
not contain internal registry/catalog endpoints or cluster identities.

## Package a task

Run resolution after reviewing a deliberate change; CI uses the resulting lock.

```bash
node dist/cli.js task resolve tasks/review --environment tst --write-lock
node dist/cli.js task validate tasks/review --environment tst
node dist/cli.js task package tasks/review --environment tst --out artifacts/task
```

The generated ConfigMap has content identity and immutable data. The generated
values carry file-to-path mappings, trigger configuration, runtime deadlines and
selected Kubernetes access. Create it using your namespace-scoped deployment
identity before Helm references it. Do not overwrite an existing task revision.

Configure the actual image digest, credential Secret names, CA bundle and egress
rules in your own values file. The sample digest of zeroes is a placeholder, not
an available image. `--wait` on a CronJob does not prove its future task runs.

## Per-task persistence

The chart creates a retained RWO PVC unless `persistence.existingClaim` is set.
Verify advisory locking and CSI fencing for your storage. One release should own
one task state directory. A manual worker against an already running task fails
its lock instead of creating a concurrent executor.

Retained PVCs may require `existingClaim` when reinstalling a release. Review
ownership before adoption. Delete state explicitly only when accepting loss of
deduplication/cooldowns and after reconciling external effects.

## Source credentials

GitLab source/output connections reference environment variable names. Existing
Kubernetes Secrets inject values through `credentials.envFromSecrets`. Live preview
needs a separate read-only GitLab identity. Tokens with API write scope are not
inherently comment-only; keep bot membership limited to the selected projects.

Kubernetes workers use the dedicated ServiceAccount and namespaced Roles. Enabling
repair grants patch only for configured Deployment names, while the action adapter
checks the allowed patch semantics. RBAC alone cannot restrict patch contents.

Optional `externalSecret` uses namespaced `SecretStore` and
`external-secrets.io/v1`; verify the installed ESO API. It is disabled by default.

## Delivery pipelines

The generic GitLab pipeline splits validation, image build, chart packaging and a
consumer deployment template. Its Docker-in-Docker image job needs a suitable
runner. Internal installations can replace image/chart publishing jobs with
their existing catalog components while keeping immutable image/digest handoff.

`.sentinel-deploy` is intentionally hidden: a consumer supplies its deployment
tool image, kube context/namespace, values file and task. The deploy tool image
must include Sentinel, Helm and kubectl. The ordinary runtime image contains only
the worker/CLI and Linux lock tooling.

GitHub validation does not deploy anything. The manual image workflow publishes
to the authenticated repository owner's GHCR namespace; package visibility and
registry access are controlled separately by GitHub settings.

## Acceptance in your cluster

First run the refinement task with publication disabled. Inspect its actual output
and scope, then enable bot-note publication explicitly. Add the Kubernetes observer
in report mode next. Exercise the restart playbook only against an explicitly
opted-in disposable stateless workload and verify its rollback/recovery behavior.
