# Business Workspace License — Operations Runbook

## Daily
- License Manager: check *Payment overdue*, *Would be suspended (dry run)* and *Needs review*.
- Company detail → *Notices sent*: a `failed` notice means e-mail did not go out (the next job run retries up to 5 times).

## Switches (Vercel environment, production)
| Variable | Effect |
|---|---|
| `LICENSE_AUTO_SUSPEND=on` | Automatic suspension at the end of grace. **Leave unset until the founder approves** (dry run). |
| `LICENSE_ENFORCEMENT=off` | Emergency: the gate stops restricting anyone (takes effect on the next request; cache ≤ 15 s per server). |
| `LICENSE_ADMIN_NAME` | Name recorded on admin actions. |

## Procedures
- **Wrongly assigned license** — if no payment was confirmed: *Cancel* (immediate, reason "assigned in error") then assign correctly. If a payment was confirmed: *Reverse* it with a reason first.
- **Company suspended in error** — *Reactivate without payment* until a date (≤ 30 days) with the reason, or *Extend grace*; then confirm the payment when it arrives.
- **Delayed payment** — *Record a payment* with the bank/NayaPay reference and *Confirm*; dates extend from the missed boundary; access returns immediately.
- **Extend a grace period** — *Extend grace* (1–30 days, reason).
- **Failed export** — the company can request a new one from Billing; in the detail page *Data exports* shows the safe error. "File storage for exports is not available" means the Filebase bucket is unreachable or unconfigured.
- **Failed notification** — retried automatically by the next hourly run; check the company's billing contacts (Owners/Admins) have valid e-mails.
- **Payment correction** — *Reverse* (never edit); if flagged *needs review*, check the paid-through date and record/confirm the correct payment.
- **Cross-tenant authorization concern** — run `node scripts/sqa/license-route-coverage.mjs` (must report no REVIEW routes) and `npm run test:one -- test/license-lifecycle.test.mjs` (tenant-isolation tests).

## Job
`/api/cron/licenses` runs hourly (`5 * * * *`). It is safe to run by hand (Bearer `CRON_SECRET`); repeated runs change nothing. `job_runs` records each run.

## Metrics
`license.entitlement_denied`, `license.transition`, `license.job_run`, `license.notice`, `license.export_job`, `license.payment` (Settings → metrics / `METRICS_TOKEN` endpoint).
