# Manage Orders — release notes, runbook, limitations and rollback

SOW: INAYA-BOS-WO-RO-TECH-OPS-SOW-2026-V1. Audit: `PHASE0_AUDIT.md` (owner-approved 25 Nov 2026).

## What ships

| Area | Code | Reuses |
|---|---|---|
| Entitlement, roles, settings | `src/lib/ops/core.js` | feature flags, workforce branch scope, `calendar_records` |
| Work + Repair Orders, parts, assets, estimates, RO invoice | `src/lib/ops/jobs.js` | `inventory.js`, invoice engine, CRM contacts, Procurement POs |
| Scheduler, eligibility, assignment chart | `src/lib/ops/scheduler.js` | workforce shifts/punches, HR leave |
| Job activity, evidence, technician day, review queue, site codes | `src/lib/ops/activity.js` | workforce attendance, support file checks + scanner, encrypted object storage |
| Preventive maintenance | `src/lib/ops/pm.js` | cron |
| Cheques | `src/lib/ops/cheques.js` | expenses, payments, ledger, AI Bookkeeper bank lines |
| PO register, dashboards, technician report, pickers | `src/lib/ops/registers.js` | Procurement, workforce timesheets |
| API | `src/app/api/orgs/ops/[[...path]]/route.js` | session + membership |
| Cron | `src/app/api/cron/ops/route.js` (every 15 min) | `CRON_SECRET` |
| Web UI | `src/components/business/ManageOrdersView.js` (Sales › Work and repair orders) | ERP navigation |
| Mobile | `inaya-mobile`: `MyJobsScreen.js`, `JobScreen.js`, `utils/jobNative.js` | Business OS stack, Time & Rota punches |

No new database collections (kinds `ops_*` in `calendar_records`), 5 new partial indexes (`ops_key`, `ops_key2`, `ops_list`, `ops_assignee`, `ops_job_ref`).

## Release gate (owner decision)

1. Deployed with `FEATURE_MANAGE_ORDERS` unset: invisible and refused for every company.
2. Switched on only for the founder company "Inaya Network" (License Manager › add-on, or `features.FEATURE_MANAGE_ORDERS = true`).
3. Live end-to-end checks run there; evidence shown to the owner.
4. Customer release only on owner approval: Vercel env `FEATURE_MANAGE_ORDERS=on` (reaches Business and Enterprise only) or per-company grants in the License Manager.
Kill switch: `FEATURE_MANAGE_ORDERS=off` hides it everywhere (data is kept).

## Limitations (stated honestly)

- **Mobile camera, QR scanning and location need the next app build.** An OTA update on an older build shows the screens with fallbacks: photo from files, typed site code, no location.
- **Push notifications:** in-app notifications only (the app shows them on the My jobs screen); no lock-screen push yet.
- **Offline:** online-first. With no connection nothing is saved and the screen says so; retries reuse the same request key so nothing is recorded twice. There is no offline queue for job actions.
- **Cheque layouts** for Generic PK, HBL, Meezan and MCB are starting points, not measured against real leaves. Each company aligns with the plain-paper test print and ticks "checked against a real leaf". Physical printing has not been verified on a pilot bank/printer yet (SOW 22.6 last item).
- **Customer estimate approval** is recorded by staff (customer name + method). Customers can't approve in the portal themselves yet.
- **Returned (bounced) cheques** are marked returned; reversing the payment is done in Finance.
- **AI suggestions:** technician suggestions are rule-based (eligibility, then fewest open jobs). No model-generated estimates or diagnoses.

## Runbook

- **Enable for a company:** License Manager › company › add-ons › Manage Orders › Switch on (reason required, audited).
- **Roles:** Manage Orders › Settings › Roles (owner/admin). Branch limits: Time & Rota › Manage users.
- **Stuck lock:** a technician lock expires by itself after 15 s.
- **Cron health:** `GET /api/cron/ops` (bearer `CRON_SECRET`) returns `{ pm, exceptions }` with per-job ok/error.
- **Stock check:** existing `reconcileStockLevels` covers job movements (they are normal `CONSUME`/`RETURN` movements with `ops:` idempotency keys).

## Rollback

1. Set `FEATURE_MANAGE_ORDERS=off` on Vercel (instant, no deploy) — menu and APIs disappear; data stays.
2. To remove the code: revert the release commit. `ops_*` documents are inert without the code; the 5 indexes can stay or be dropped by name.
3. Mobile: the next OTA without the screens removes them; native modules in a build are harmless when unused.
