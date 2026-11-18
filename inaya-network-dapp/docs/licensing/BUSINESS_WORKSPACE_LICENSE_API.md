# Business Workspace License — API

All responses are JSON unless noted. Errors: `{ error, code? }` with a matching HTTP status.

## Company (session cookie or `Authorization: Bearer <session>`)

| Method & path | Who | Returns |
|---|---|---|
| `GET /api/orgs/license/status?orgId=` | any member | `{ license: { state, label, access, isManager, deadline?, deadlineText?, remaining? } }` (deadline only for Owner/Admin) |
| `GET /api/orgs/license?orgId=` | Owner/Admin | license view (package, cycle, amount, dates, grace countdown), `payments`, `exports`, `policy`, `paymentInstructions` |
| `GET /api/orgs/license/documents?orgId=` | Owner/Admin | Documents-module files for read-only download |
| `GET /api/orgs/exports?orgId=` | Owner/Admin | recent export jobs |
| `POST /api/orgs/exports?orgId=` | Owner/Admin | `202 { export }` (built in the background) or `200 { existing: true }`; `429` over the daily limit |
| `GET /api/orgs/exports/:id/download?orgId=` | Owner/Admin of that company | the ZIP (`application/zip`); `409` not ready, `410` expired, `404` other company |

## Admin portal (admin session cookie)

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /api/admin/licenses` | filters: `status, cycle, plan, currency, method, q, dueFrom, dueTo, graceFrom, graceTo, activatedFrom, activatedTo, renewalsWithinDays, page, pageSize` | `{ summary, total, page, pageSize, rows, plans, pkPackages }` |
| `GET /api/admin/licenses?companies=<q>` | | company picker |
| `GET /api/admin/licenses/:orgId` | | license, history (periods, payments, events), notices, exports, renewal preview |
| `POST /api/admin/licenses/:orgId` | `{ action, confirm, … }` | actions: `assign`, `preview_renewal`, `record_payment`, `confirm_payment`, `reject_payment`, `reverse_payment`, `change`, `extend_grace`, `suspend`, `reactivate`, `cancel`, `note`. High-impact actions require `confirm: true`. Idempotency keys accepted on `assign` and `record_payment`. Rate-limited (120/min). |
| `GET /api/admin/licenses/export` | same filters | `.xlsx` workbook; every export is audited |
| `GET /api/admin/licenses/migration` | | pre-license subscriptions |
| `POST /api/admin/licenses/migration` | `{ action: "adopt", orgId, amount?, confirm }` or `{ action: "bulk", rows, preview, confirm? }` | migration / bulk assignment |

## Job
`GET /api/cron/licenses` (Bearer `CRON_SECRET`), hourly at :05 — returns the job summary and whether automatic suspension is on.
