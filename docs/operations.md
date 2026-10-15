# Operations

## Inspect

Continuous workers expose `/healthz`, `/readyz` and `/metrics` on the configured
port. Liveness tracks the process, while readiness reflects discovery/item errors.
Allow your monitoring namespace explicitly through the network policy.

`task status --state <path>` reads an existing database without resetting running
work. Its data is local to that task; for Kubernetes use workload/log access with
your explicit context. Do not mount a live state volume into another writer.

Read `run_completed`, `run_report`, `discovery_failed`, `item_failed`,
`stale_result_deferred` and `incident_recovered` structured stdout events through
your existing logging path. `run_report` includes the rendered result fields for
stdout tasks. Detailed JSON/Markdown/HTML files are available with `--artifacts`;
configure lifecycle cleanup if retaining that optional directory long term.

## Pause and rollback

Set `enabled: false`, resolve the task and deploy through Git. The chart suspends
CronJobs/Jobs or scales the continuous Deployment to zero. Manual controller
changes can be overwritten by your deployment automation.

Roll back image, chart and task-package references together where appropriate.
Retain referenced ConfigMaps and state. The current SQLite schema version is 1;
future migrations must preserve an explicit rollback compatibility range.

## Reprocess one item

Stop the worker first and acquire the same state lock before maintenance. Use the
source ID displayed in its report; do not blindly reset the database.

```bash
PI_SENTINEL_MAINTENANCE=true flock --nonblock /state/pi-sentinel.sqlite.lock \
  node dist/cli.js task reprocess 'example/platform#123' \
  --state /state/pi-sentinel.sqlite
```

Restart the normal worker afterward. Reprocessing respects action receipts,
cooldowns and output identity. A new prompt revision alone does not replay an
unchanged backlog.

## Failure interpretation

| Signal                              | Meaning / next step                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `task.lock.json is stale`           | Review the configuration diff, then intentionally resolve the lock        |
| Discovery failure                   | Source access is degraded; an empty result has not been established       |
| Partial coverage                    | Some required evidence was unavailable or bounded/truncated               |
| Task model allowance exhausted      | Backlog is deferred; inspect daily counters and bounds                    |
| Flock exit 75                       | Another process owns the state lock                                       |
| Uncertain repair                    | Reconcile target annotation/UID; do not repeat a mutation blindly         |
| Equivalent report already published | Existing bot output was preserved; no duplicate comment                   |
| Preview has no successful result    | Inspect preceding item failures; process success is not a quality verdict |

The default failed-item retry count is bounded. Repeated source outages back off.
Daily inference ceilings reset at UTC calendar-day boundaries, using conservative
reservations when usage is unknown. These counters do not establish billing cost.

No model health claim, automatic repair or live-cluster acceptance follows solely
from mock test success. Verify the actual source versions, router and workload.
