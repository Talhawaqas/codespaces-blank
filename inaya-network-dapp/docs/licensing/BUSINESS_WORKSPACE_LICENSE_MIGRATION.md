# Business Workspace License — Migration and Rollback

## Migration (launch, 1 January 2027)
Nothing is converted automatically. In the License Manager → **Launch migration**:
1. **Paid companies from before licenses** (activated on `/admin/billing` before 17 Nov 2026): *Adopt* each one. The license becomes active with the existing paid-through date; no payment is recorded or inferred.
2. **Pilot / free companies that agreed to pay**: assign individually or with **Bulk assignment** (preview first). Each starts awaiting its first payment; nothing is charged; nothing is deleted.
3. Companies that have not agreed to pay are left alone (no license = existing onboarding rules; no restriction).
4. Keep the migration report: the register export (Excel) after migration lists every license and its outcome; *License Activity* shows each assignment.

Database changes are additive: new fields on `org_subscriptions`, new rows (`kind`) in `billing_requests`, and partial indexes. The unique `orgId` index on `org_subscriptions` is created on first use; if old duplicate rows exist it is not built (logged) and the service still refuses duplicates.

## Enabling suspension
1. Confirm in a test environment: grace reminders arrive, a suspended company keeps Billing/export, payment restores access.
2. Set `LICENSE_AUTO_SUSPEND=on` in Vercel (production) and redeploy.

## Rollback
- **Stop all restrictions immediately**: `LICENSE_ENFORCEMENT=off` (no deploy needed beyond the env change + redeploy). Automatic suspension stops with `LICENSE_AUTO_SUSPEND` unset.
- **Stop the job**: remove `/api/cron/licenses` from `vercel.json`.
- **Code rollback**: revert the License Manager commit. The extra fields and ledger rows are ignored by the older code (`org_subscriptions.plan/status/currentPeriodEnd` are kept in sync, and activation requests are read only where `kind` is absent). No data needs to be deleted.
