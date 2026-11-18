# Business Workspace License — Implementation

## Components (`src/lib/licensing/`)

| File | Responsibility |
|---|---|
| `config.js` | Policy settings (founder decisions): PKT, 14-day grace, daily grace reminders, max extension 30 days, export TTL, `autoSuspendEnabled()`, `enforcementEnabled()`, admin actor name |
| `dates.js` | The only date code: `addCycles` (anchor day), `paymentDueAt`, `graceEndsAt`, `remaining`, `formatDeadline`, `graceDay` |
| `state.js` | State machine (`TRANSITIONS`, `assertTransition`) and `effectiveState(license, now)` — the access decision |
| `service.js` | Every change: `assignLicense`, `recordPayment`, `previewRenewal`, `confirmPayment`, `rejectPayment`, `reversePayment`, `changeSubscription`, `extendGrace`, `suspendLicense`, `reactivateLicense` (override), `cancelLicense`, `addNote`, `systemTransition`, history, `legacySubscriptions`, `adoptLegacySubscription`, `bulkAssign` |
| `gate.js` | Central enforcement: `licenseGate` (called from `requireMembership`), `companyMayOperate` (for keys, links, jobs), 15 s per-server cache, `invalidateLicenseCache` |
| `notices.js` | Mandatory billing e-mails to Owners/Admins + in-app notice; one per license/type/period; failed sends retried |
| `job.js` | Hourly job (`/api/cron/licenses`): due-soon notice, start grace, reminders, suspension (or dry run), exports |
| `exports.js` | Company export jobs: request, build ZIP (records + S3/NAS files + manifest), store encrypted, download, expire |
| `admin.js` | License Manager list/filters/summary, company search, four-sheet workbook |

## License state machine

`pending_activation → active` (first payment confirmed) · `active → grace_period` (due instant passed) · `grace_period → active` (payment) · `grace_period → suspended` (deadline, job) · `suspended → active` (payment) · `suspended → grace_period` (extension / override) · `active|grace|suspended → cancelled` · `cancelled|expired → active` (payment). Anything else is refused (`assertTransition`). Stored transitions are conditional on status + `licenseVersion`, so a stale or repeated job can never move a license backwards.

Access is decided by `effectiveState` from the stored deadlines, so it is exact at the deadline even before the job runs. With automatic suspension off (production default, "dry run") the deadline passing is recorded but access stays normal.

## Renewal policy (decision 3)
First payment: period starts at the license start date. Every later payment extends from the previous paid-through date, also during grace and after suspension — no free days and no lost days. A suspended/cancelled company can be restarted on a chosen date only by an explicit admin choice (`restartFrom`). The admin sees the resulting dates before confirming (`preview_renewal`).

## Enforcement coverage
- 634 routes through `requireMembership` (central gate).
- 74 routes through gated helpers: public API keys, support API keys, S3/Azure/GCS keys, AWS infrastructure keys, share links (v1 and v2), customer portal, file-request upload links, booking pages, meeting guest links, external data rooms, gateway devices, node enrolment, identity API and webhooks, workflow webhooks.
- Scheduled jobs acting for a company skip restricted companies: workflow executions, org webhooks, S3 event notifications, approved AI actions, appointment reminders, marketing campaigns, document-automation jobs, task reminders, automatic reorder. Data-protection jobs keep running (backups, retention, revocations, purges).
- Coverage is checked by `scripts/sqa/license-route-coverage.mjs` and `test/license-route-coverage.test.mjs` (fails if a new route reaches company data without the gate).

## Feature flags / switches
- `LICENSE_AUTO_SUSPEND` — `on` enables automatic suspension. **Unset in production = dry run** (SOW 27.16). On outside production.
- `LICENSE_ENFORCEMENT=off` — emergency kill switch for the gate (restricted companies regain access immediately).
- `LICENSE_ADMIN_NAME` — name recorded on admin actions.

## Activation flow
`/admin/billing` → *Activate* now creates the license (or renews / changes it) and records and confirms the payment through the service, so every package has one license, one payment history and one audit trail.

See also: data model, permission matrix, API, admin guide, runbook, migration, export manifest, test report (this folder).
