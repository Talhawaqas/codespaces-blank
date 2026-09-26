# AI Business Operations Manager — Audit, Plan and Implementation Report

Status: **implemented and verified against the real database; Slack, Gmail and a real helpdesk are NOT yet verified live** (see section 10). Test results are in section 11.

Principle followed: AUDIT → REUSE → CONNECT → IMPLEMENT ONLY GENUINE GAPS → TEST → SECURE → PROVE.

## 1. Phase 0 — Audit (answers to SOW §5)

| # | Question | Finding (real files) |
|---|---|---|
| 1 | Existing workflow/orchestration code | Only per-domain state machines (`invoice-workflow.js`, `task-workflow.js`, …), guided tasks (`guided-tasks.js`), and job engines local to a feature (`nas/jobs.js`, `documentAutomation/jobs.js`). **No user-defined, node-based workflow layer exists.** |
| 2 | Scheduled jobs / cron | Vercel crons in `vercel.json` hitting `src/app/api/cron/*` with `CRON_SECRET` bearer. The production Vercel account is on a paid plan, so sub-daily schedules are allowed (`vercel.json` already runs several every 5 minutes; the old "Hobby, daily only" comment in `cron/execute-approved-ai-actions` is stale). `scripts/nas-worker.mjs` is the pattern for a standalone worker. |
| 3 | Background workers | `scripts/nas-worker.mjs`, `cloudBackupScheduler.js`. Reused as the pattern. |
| 4 | API endpoints suitable as actions | The permission-scoped read layer is `getAccessibleScope()` (`document-permissions.js`) via `buildBusinessContext()`; consequential changes go through `proposeAiAction()`. Workflows call these libraries directly, not HTTP. |
| 5 | Notification mechanisms | `notifications.js` (`createNotification`, unique `dedupeKey`), `email.js` (`sendEmail`, Resend). |
| 6 | AI tool-calling infrastructure | `ai-business-tools.js` (`BUSINESS_TOOL_DECLARATIONS`, `runBusinessTool`), `ai-tool-registry.js` (registry with risk/permissions/approval fields). |
| 7 | Gemini integration | `@google/genai`, model `gemini-3.5-flash-lite`, server-side key only (`business-brief.js`, `business-chat`). Groq fallback exists for chat only. |
| 8 | Memory | **None for agents** (chat history is per-request). Genuine gap → workflow-scoped memory. |
| 9 | Audit/evidence | `logOrgActivity` → hash-chained `audit_chain_entries`; Evidence Graph `businessEvents.js` (subject registry); pattern proven by `nas/evidence.js`. |
| 10 | Permission checks callable from workflows | `getMembership`, `canManageOrg/Finance/HR`, `canAccessDepartment`, `getAccessibleScope`. |
| 11 | Business Brief / KPI | `generateBusinessBrief`, `computeBusinessInsights` (both permission-aware). |
| 12 | Digital Twin | `simulateDigitalTwinScenario` (read-only by construction, 11 scenarios incl. NAS). |
| 13 | Evidence Graph | `createBusinessEvent`, `addBusinessEventRelationship`, timeline/passport/explain. |
| 14 | Approval/action engine | `ai-action-requests.js` (PENDING_APPROVAL → APPROVED → 36h → EXECUTED), `ai-action-approval-gate.js`. **Reused, not duplicated.** |
| 15 | Scheduler/queue/retry | Pattern in `nas/jobs.js` (unique idempotency, checkpoint, backoff, stale-heartbeat recovery). No generic queue → a workflow-specific durable queue is a genuine gap. |
| 16 | Mongo models reusable | orgs, org_members, departments, projects, crm_*, invoices, tasks, purchase*, products, employees, business_events, ai_action_requests, notifications, integrationConnections, aiSecurityChecks, nasThreatEvents, backup collections. |
| 17 | Secret/credential mgmt | `integrationCrypto.js` (AES-GCM with server key) used by `integrationOauth.js`. Reused for workflow credentials. |
| 18 | Rate limiting | `rateLimit.js` (`checkRateLimit`), `aiSecurity/rateLimiting.js`. |
| 19 | Notification dedupe | `createNotification`'s unique `dedupeKey`. |
| 20 | Observability | `org_activity`, audit chain, per-feature metrics; nothing generic. |

Additional facts that shape the design:

- **There is no support-ticket system in Inaya.** The "Get Support Tickets" node therefore reads from the
  organization's own helpdesk through the controlled HTTP connector (credential reference + allowed hosts). It is
  labeled **unverified against any real helpdesk vendor** and is tested against a local test server only.
- **Slack**: an OAuth connection exists (`integrationProviders/slack.js`) but nothing sends messages → genuine gap. **Gmail**: only
  Google identity sign-in exists; Google Workspace OAuth has no `gmail.send` scope. Inaya-native email (`sendEmail`) is the
  verified email path; a Gmail-API adapter is added and labeled unverified.
- The list_* AI tools cap results at 25 rows; workflow data nodes read the same permission scope (`ctx.scope.visible*`) directly with
  their own bounds rather than bypassing it.

## 2. Reuse map

| SOW need | Reused | New (genuine gap) |
|---|---|---|
| Data nodes (CRM, tasks, invoices, procurement, inventory, projects, documents) | `getAccessibleScope` / `buildBusinessContext` | thin node wrappers + declared scopes |
| KPI snapshot | `computeBusinessInsights` | snapshot envelope (period, sources, scope, calc metadata) |
| Business Brief node | `generateBusinessBrief` | node wrapper |
| Trust/security/backup | `computeTrustHealth2`, `aiSecurityChecks`, `nasThreatEvents`, backup collections | node wrappers |
| Evidence Graph read/write | `businessEvents.js` | `WORKFLOW_EXECUTION` subject type + evidence rows (mirrors `nas/evidence.js`) |
| Digital Twin | `simulateDigitalTwinScenario` | node wrapper (simulation-only) |
| AI model | Gemini via `@google/genai` | agent node with structured output, tool loop, AI-security gateway |
| Tool safety | `ai-tool-registry.js` shape | workflow tool registry with permission enforced outside the model |
| Approvals / controlled actions | `proposeAiAction` (36h delay) | execution WAITING_APPROVAL + resume |
| Notifications | `createNotification`, `sendEmail` | Slack sender, Gmail adapter, delivery ledger |
| Credentials | `integrationCrypto.js` | credential references (`workflowCredentials`) with audited use |
| Audit | `logOrgActivity` → audit chain | workflow event vocabulary |
| SSRF guard | `assertSafeEndpoint` (`nas/cloudTargets.js`) | HTTP node with allowlist, size/time limits, redaction |
| Rate limits | `checkRateLimit` | per-workflow execution budgets |
| Queue | pattern of `nas/jobs.js` | durable execution queue with lease/heartbeat/dead-letter |

## 3. Genuine-gap list (what is built)

1. Workflow definition model + immutable versions + rollback (§7, 35).
2. Typed node model, validation (§8, 34) and a safe expression engine (no `eval`) (§11, 17).
3. Transform nodes (merge/join/filter/map/select/rename/sort/aggregate/group/dedupe/derive) (§11).
4. Server-side execution engine + durable queue + scheduler (§20, 21, 58, 59).
5. Controlled HTTP connector with SSRF protection (§10) and credential references (§32).
6. AI Operations Manager agent node: structured output, allow-listed tools, workflow memory, AI security gateway (§13–16, 36, 37).
7. Notification nodes: Inaya, email, Slack, Gmail (§18, 30, 43, 57).
8. Test mode, dry run, evaluations (§24–26).
9. Evidence integration, explainability, passport export (§27, 47, 68).
10. Reports, templates, import/export, sharing, retention, metrics, automation health (§41, 42, 44, 48, 54–56, 70).
11. Visual editor + executions/evaluations/templates/health UI (§33, 52, 53).
12. Workflow Copilot (§67) and simulation-before-publish (§69).
13. API surface + cron + worker (§51).

## 4. Threat model (summary)

Assets: business data, credentials, the ability to act. Actors: malicious/low-privilege member, compromised workflow
definition (import), untrusted document text reaching the AI, other tenants, network attacker (SSRF/webhooks).
Controls: permission re-resolved at execution time from live membership (never from the definition); workflow-declared data
scopes must be both granted to the publisher and held by the executing identity; AI can only invoke registered tools, tool
names/arguments are validated outside the model, and it can never reach a mutating tool except via `proposeAiAction`; retrieved
text is delimited as untrusted and screened by the AI Security gateway; HTTP node blocks private/metadata/localhost/non-https,
enforces allowlist, timeouts and size caps; secrets are stored only as encrypted credential records referenced by id and are
redacted from every stored input/output/log; webhooks use per-workflow secrets with HMAC + timestamp + replay ledger; external
sends are claimed in a unique ledger before sending (at-most-once, never duplicated on retry).

## 5. Implementation plan (phases)

- **P1 Core libs**: expression engine, transforms, schedule, node schema/validation, credentials, HTTP node, tool registry.
- **P2 Engine**: data/KPI nodes, AI agent + memory, notifications, evidence, executions, queue, scheduler, test/dry-run, evaluations.
- **P3 Service + API**: CRUD/versions/publish/rollback/sharing/import/export/templates/copilot/explain/health/metrics + routes + cron + worker.
- **P4 UI**: editor, templates, executions, evaluations, automation health; Business Workspace navigation.
- **P5 Verification**: unit, integration (real MongoDB), security, failure and acceptance tests (SOW §60–63); regression; docs.

## 6. What was built (files)

| Area | Files |
|---|---|
| Engine | `src/lib/workflows/engine.js` (execution), `queue.js` (durable queue, leases, scheduler, event triggers), `runner.js` (one worker pass), `schedule.js`, `expr.js` (no-`eval` expression engine), `transform.js` |
| Model | `nodes.js` (typed nodes, validation, scopes, settings), `templates.js` (7 templates), `service.js` (lifecycle, versions, sharing, import/export, triggers) |
| Data and AI | `data.js` (data nodes + KPI snapshot), `ai.js` (agent), `tools.js` (tool registry), `memory.js`, `reports.js` |
| Safety | `http.js` (SSRF-safe connector), `credentials.js`, `effects.js` (at-most-once side effects), `notify.js` (Inaya, email, Slack, Gmail) |
| Evidence | `evidence.js` (rows, audit-chain commitment, Evidence Graph, passport), `explain.js` |
| Quality | `evaluations.js`, `metrics.js` (metrics, automation health, retention), `copilot.js`, `catalog.js` |
| API | 36 route files under `src/app/api/orgs/workflows/**`, `api/workflow-hooks/[workflowId]`, `api/public/v1/workflows/[id]/run`, `api/cron/workflows` |
| UI | `src/components/business/WorkflowsView.js`, `workflows/Editor.js`, `workflows/panels.js`; Business Workspace navigation "Automations" |
| Ops | `scripts/workflow-worker.mjs`, `scripts/gmail-refresh-token.mjs`, `docs/workflow-slack-app-manifest.json`, `vercel.json` (cron every 5 minutes) |
| Existing files touched (additive) | `orgs.js` (10 collections + indexes), `businessEvents.js` (subject `WORKFLOW_EXECUTION`, evidence-event trigger hook), `digitalTwinSimulate.js` (twin-completion trigger hook) |

## 7. SOW section coverage

| SOW § | Delivered |
|---|---|
| 7, 35 | Draft + immutable, hash-verified versions; publish, rollback, version history; the engine refuses a version whose hash changed |
| 8 | Manual, schedule (timezone, start/end, daily/weekly/monthly/interval, next-run), event, webhook (HMAC, timestamp, replay ledger), API-key, Evidence Graph, Digital Twin completion, data-change triggers |
| 9, 12, 29 | 14 data nodes + KPI snapshot + Business Brief, all through the executing identity's live permission scope |
| 10, 32 | Controlled HTTP node (https only, allowlist, no private/metadata/loopback, no redirects, size/time limits, DNS-rebinding-safe lookup); credentials by reference, encrypted, audited |
| 11, 17 | Merge/join/filter/map/select/rename/sort/aggregate/group/dedupe/derive; safe expression language; conditions with AND/OR/NOT, thresholds, AI result |
| 13-16, 36, 37, 49 | AI agent: structured schema-validated output, deterministic thresholds, allow-listed permission-checked tools, workflow-scoped memory with retention, minimisation (pseudonymised people, PII redaction, capped rows), injection screen + AI Security gateway |
| 18, 30, 43, 57 | Inaya notification, email, Slack, Gmail; dedupe keys per the SOW formula; delivery status; failure notification |
| 19, 40 | Risk classes; high-risk = propose only, through the existing controlled-action approval (36 h delay), execution waits, resumes on the real outcome |
| 20-23, 39 | Executions with all nine statuses, node-level inspection, retries with attempt history, partial runs never shown as complete |
| 21, 59 | Durable queue with lease/heartbeat, retry backoff, dead-letter, idempotency, crash resume, concurrency limits |
| 24-26 | Evaluations, test mode (synthetic data), dry run (real reads, simulated writes) |
| 27, 46, 47, 68 | Evidence rows committed into the org's hash-chained audit trail, Evidence Graph relationships, exportable passport, explain view without hidden reasoning |
| 28, 63, 69 | Digital Twin node (read-only), simulation-before-publish via test mode |
| 31, 58 | Live membership + scopes re-checked at start and before every wave; scheduled runs refused, with a recorded reason, when the owner or org is no longer valid |
| 33, 52, 53 | Visual editor and Automations section |
| 34 | Publish validation fails closed (structure, cycles, disconnected nodes, expressions, scopes, credentials, recipients, tools) |
| 38 | Per-hour/day, concurrency, node timeout, AI timeout, max duration, HTTP/tool budgets, retry ceiling |
| 41, 54 | 7 templates; templates needing scopes the member lacks are hidden |
| 42 | 9 report types built from what the run already produced |
| 44, 70 | Metrics and Automation Health (with a Trust-Health-shaped dimension and a deduplicated manager notification) |
| 48 | Retention: AI output and executions expire; evidence rows and the audit chain are kept |
| 51 | API surface (adapted to the `/api/orgs/...` convention) |
| 55, 56 | Export without secrets, import as draft, sharing rights (view/edit/execute/publish/credentials/templates/executions/evidence) |
| 67 | Workflow copilot (draft only, never publishes, validated like any workflow) |

## 8. Security pass (SOW section 45)

Each item below has an automated test that attacks it (`test/workflow-security.test.mjs`, `workflow-acceptance.test.mjs`, `workflow-unit.test.mjs`, `workflow-routes.test.mjs`): cross-org, cross-department (a sales rep never sees finance tasks), privilege escalation (publish, scopes, self-grant; sharing does not lend access), credential leakage, secret exposure, SSRF, webhook abuse, malicious definitions (prototype keys, code-like expressions, raw secrets, forged imports), malicious node parameters, prompt injection (removed before the model, recorded as an AI-security event), tool injection (unknown, disabled, argument-smuggling and URL tools refused), replay, duplicate execution, race conditions (atomic claim), unauthorized scheduled execution, ownership changes, revoked access, deleted users, disabled organizations, expired credentials, notification leakage (PII redacted for external channels) and evidence tampering (edited row, deleted audit entry, tampered version).

Real defects these tests found and that are fixed: disabling a workflow with no schedule crashed; the execution list showed 0 nodes; the Business Brief node used the wrong period names; a failed notification was treated as delivered on retry.

## 9. Deployment

- Vercel cron: `/api/cron/workflows` every 5 minutes (`vercel.json`). The production Vercel account is on a paid plan.
- New environment variable: `INTEGRATION_ENCRYPTION_KEY` (32 random bytes, base64) is required to store credentials and webhook secrets. It was added to the Vercel project (Production, Preview). Keep a copy: a lost key means stored credentials cannot be recovered.
- Existing variables used: `GEMINI_API_KEY` (AI), `RESEND_API_KEY` (email node), `CRON_SECRET`, `MONGODB_URI`.
- The standalone worker (`scripts/workflow-worker.mjs`) is optional.

## 10. Honest limitations and unverified items

- **Slack sending** is implemented (incoming-webhook credential; a Slack-app token path also exists but needs `chat:write`, which Inaya's existing Slack connection does not request) and tested against a capturing stand-in only. **Not verified against real Slack** until a real message is delivered.
- **Gmail sending** is implemented through the Gmail API with an OAuth refresh token (`scripts/gmail-refresh-token.mjs`) and tested against a stand-in only. **Not verified against real Gmail.** Google's `gmail.send` is a sensitive scope: a personal (non-Workspace) account must publish the consent screen or the token expires after 7 days.
- **Email** node uses Inaya's existing provider (Resend); without `RESEND_API_KEY` the node fails honestly.
- **Support tickets:** Inaya has no support module. The node reads a customer's own helpdesk through the HTTP connector and has only been exercised against a local test server. A native support module is a separate piece of work (proposed as its own SOW).
- **Org suspension:** Inaya has no "disable organization" feature today; the engine honours `disabledAt` / status `DISABLED` or `SUSPENDED` on the organization record if one is set.
- **Data-change triggers** poll internal data sources; helpdesk change detection uses a schedule instead.
- **Test-mode AI** still calls the real model unless the dataset stubs it (a stub is clearly labeled in the run).
- **Audit-chain write speed:** each evidence row is an audit-chain append (about 1.4 s against the remote database). Evidence is written off the node critical path, but a very large workflow's run is bounded by that chain.
- The editor is a purpose-built SVG canvas (no third-party graph library). It compiles in the production build but has not had a full manual usability pass.
