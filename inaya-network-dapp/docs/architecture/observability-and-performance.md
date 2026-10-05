# Observability and performance (Competitive Expansion SOW sections 41, 43, 51)

## Privacy-safe metrics

Source: `src/lib/metrics/metrics.js`. Routes: `GET /api/orgs/metrics` (one organization), `POST /api/orgs/metrics/client` (client reports), `GET /api/metrics` (platform, Prometheus text).

**What is recorded.** Counters only, from a fixed catalog (`CATALOG`). A metric name that is not in the catalog is dropped. A label must be one of the values listed for that metric; anything else (a file name, an e-mail address, a message) is dropped, so free text can never become a label. Latencies are folded into fixed buckets (100, 250, 500, 1000, 2000, 5000 ms, `inf`). Storage is one counter document per (day, organization, metric, label) in `metric_counters`, expiring after 400 days. There is no per-event record.

| Area | Metrics |
|---|---|
| Chat | messages accepted, security events by type, conversation key rotations (epoch changes); client-reported decrypt failures, reconnects, attachment failures, delivery latency and unread-convergence latency |
| Storage | share links created, downloads blocked by a rule, data-loss decisions by outcome, classification results applied or suggested; client-reported preview failures |
| Gateway | heartbeats received, transfers completed |
| Compliance and keys | snapshots taken, key wrap/unwrap successes and failures |

**Gauges (read live, not stored).** Gateways registered and online, aggregate queue depth and worst lag, active shares, object count, compliance control status and evidence freshness, whether the audit chain verifies, and background-job outcomes over the last 7 days.

**What a metric does not prove.** The client-reported metrics exist only when a client sends them. A metric with no data means nobody reported it, not that the value is zero; the organization endpoint says so (`notCollected`). Server-side counters cannot be forged by a client: the client endpoint accepts only the metrics marked `client: true`.

**Who sees what.**

- Organization endpoint: owners, administrators, delegated administrators and auditors of that organization. Members get 403.
- Platform endpoint: operators holding `METRICS_TOKEN` (at least 16 characters, compared in constant time). With no token configured the route returns 404. The export sums across organizations and contains no organization id and no e-mail address.

## Performance targets and what was measured

Targets come from SOW section 51 and are engineering targets, not competitor claims.

| Target | How it is met | Evidence |
|---|---|---|
| Chat send acknowledgment under 1.5 s | the server accepts the encrypted message and returns; webhooks, notifications and metrics run after the response path and never block it | `test/performance.test.mjs` measures 30 sends against the real database and asserts p95 under 1.5 s. The figures printed by that run include the network round trip to the database; they are measurements of that run, not a guarantee for other networks |
| Reconnect without duplication | the client message id is idempotent per sender; repeated sync does not create messages | same test: repeated sync leaves the message count unchanged |
| Pagination, no unbounded reads on normal UI paths | every list function clamps its page size (shares 100, access events 200, notes list page, revisions 100, DLP events 200, deliveries 200, requests 100, job runs 200, devices 500, government access log 500) | the same test asks for a million rows and receives the cap |
| Bounded dashboards | dashboard tiles over event data use grouped counts, not loaded rows | the same test seeds 6000 backup runs and 1500 workflow runs and checks the tiles are exact |
| Background jobs do not scan whole tenants | each job runs through `withJobRun` with a lease, a minimum interval and per-organization scoping | `test/job-reliability.test.mjs` |

**Known limits.** Chat history paging and local encrypted search are client behaviours; the measurements above cover the server path. A figure from one run on a developer machine is not a capacity statement; no load test at production scale was run.
