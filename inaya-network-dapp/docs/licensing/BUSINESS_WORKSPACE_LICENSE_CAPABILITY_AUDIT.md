# Business Workspace License — Capability Audit

Audit done 17 Nov 2026, before implementation (SOW §2). Classifications use SOW §2.3.

## What already existed

| Requirement | Classification | Evidence |
|---|---|---|
| Company (organization) model, Owner/Admin/Member roles | Existing and verified | `src/lib/orgs.js` (`orgs`, `orgMembers`, `canManageOrg`) |
| Magic-link / Google sign-in, sessions | Existing and verified | `src/lib/orgs.js` (`getSession`, `createSession`), `/api/orgs/login/*` |
| Central member check for company APIs | Reusable infrastructure | `requireMembership` in `src/lib/orgs.js`, used by 634 of 946 API routes (directly or through route helpers) |
| Billing view (`?view=billing`), plan + usage | Existing, needs extension | `BillingView` in `src/app/business/BusinessClient.js`, `/api/orgs/billing` |
| Plan catalogue and entitlements | Existing and verified | `src/lib/orgPlans.js` (`PLANS`, limits), `src/lib/pkPricing.js` (PKR) |
| Activation request → admin activation (NayaPay / bank transfer) | Existing, needs extension | `src/lib/billingRequests.js`, `/admin/billing`, `/api/admin/billing-requests` |
| Subscription record | Existing, needs extension | `org_subscriptions` (one per company: `plan`, `status`, `currentPeriodEnd`) — no license id, no grace, no history |
| Payment records / history | Missing | only a `paymentReference` string on the activation request |
| Grace period, reminders, suspension | Missing | — (Stripe-era `past_due` status only) |
| Server-side license enforcement | Missing | — |
| Company ZIP export | Existing, needs extension | `/api/orgs/export-zip`, `src/lib/orgDataExport.js`: synchronous, records only, no files, no job/expiry |
| Notification router (in-app + e-mail, de-duplication) | Reusable infrastructure | `src/lib/notify/router.js` (`notifyEvent`, `dedupeKey`), `src/lib/email.js` |
| Cron / job safety | Reusable infrastructure | `vercel.json` crons, `src/lib/jobs/run.js` (`withJobRun`: single live run, stale takeover) |
| Audit / activity log | Reusable infrastructure | `src/lib/org-activity-log.js`; license audit added as append-only ledger rows |
| Admin Portal + auth | Existing, needs extension | `/admin/*`, `src/lib/admin-auth.js` — one shared passphrase, no individual admin accounts or roles |
| Metrics | Reusable infrastructure | `src/lib/metrics/metrics.js` (registered metric names) |
| XLSX writer with formula-injection guard | Reusable infrastructure | `src/lib/bookkeeper/exportFormats.js` (`toXlsx`, `guardText`) |
| Transactions | Reusable infrastructure | pattern from `src/lib/chat/conversations.js` (`withTxn`) |
| Database collections | Constraint | Atlas is at its 500-collection limit: no new collections may be created |

## Founder decisions (SOW §26), 17 Nov 2026

1. Billing timezone: PKT (UTC+5). A payment is due at the end of its due date in PKT. All instants stored in UTC.
2. A license is active only after its first payment is confirmed.
3. Renewal anchor: always extend from the previous paid-through date (during grace and after suspension too).
4. Monthly/yearly keep the original billing day: 31 Jan → 28/29 Feb → 31 Mar; 29 Feb → 28 Feb in non-leap years.
5. Retention after suspension: nothing is deleted; no deletion process exists.
6. Cancellation: access continues to the paid-through date; an admin may end it immediately with a reason.
7. Billing notices go to every Owner and Admin.
8. Payment proof: admin-entered reference; no customer upload in this release.
9. Grace extensions: reason required, at most 30 days per extension.
10. Suspended company: Owners/Admins can sign in, use Billing, contact support and export; nothing else.
11. Export: all records plus S3/NAS file contents; Documents files (passkey-encrypted) downloadable read-only while suspended.
12. Admin reports: global only.
13. The founder is the only admin: the shared admin passphrase stays; the actor recorded on admin actions is `LICENSE_ADMIN_NAME` (default "Inaya admin").
Grace period: 14 days (confirmed).

## Out of scope (SOW §3.2)
Card processing, NayaPay/bank APIs, invoicing/tax engine, per-seat licenses, DePIN / wallet storage billing (untouched: `walletStore.js`, `/api/wallet/*`, `stripe-webhook`), automatic data deletion.
