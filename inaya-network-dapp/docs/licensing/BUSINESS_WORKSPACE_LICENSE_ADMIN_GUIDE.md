# License Manager — Admin Guide

Open **Admin portal → License Manager** (`/admin/licenses`).

## Dashboard
Counters at the top come from the database: companies with a license, active, awaiting first payment, payment overdue (grace), suspended, cancelled/expired, monthly vs yearly, renewals due in 30 days, "would be suspended (dry run)" and "needs review". Filter and search the register below; click a row for the company.

## Assign a license
1. **Assign a license** → find the company by name or id.
2. Choose the package, monthly or yearly, currency and the **agreed amount** (the price-book amount is suggested; enter the pilot price where one was agreed).
3. Choose the start date (PKT).
4. Decide the first period: **awaiting payment** (the company stays inactive until you confirm a payment) or **already paid** (enter method, reference and date: the payment is recorded and confirmed and the company becomes active).
5. Review and confirm. The assignment is audited.

## Payments
- **Record a payment** (amount, periods, method, reference, date): it is saved as *pending* and changes nothing.
- **Confirm** a pending payment: you see the paid-through date before and after. If the amount differs from what is expected you must give a reason. Confirming twice has no effect; a reference that was already confirmed is refused.
- **Reject** a pending payment (reason required).
- **Reverse** a confirmed payment (reason required): the original stays on record and a reversal is added. If it was the latest renewal, the paid-through date goes back; otherwise the license is flagged *needs review*.

Renewal rule: a payment always extends from the previous paid-through date, also when it arrives during grace or after suspension.

## Grace period and suspension
- A payment is due at the end of its due date (PKT). Next, the company is in grace for **14 days** with normal access. Owners and Admins get a notice when the payment becomes overdue and then **a reminder every day** (e-mail and in-app): "X days remaining until your license is suspended", with the exact deadline; the last day says "1 day remaining". Each day is sent once, even if the job runs again.
- At the end of grace the company is suspended **only if automatic suspension is on** (`LICENSE_AUTO_SUSPEND=on`). While it is off (current production setting) the register shows "suspension due (dry run)" and access stays normal.
- **Extend grace**: 1–30 days with a reason; lifts an automatic suspension if the new deadline is in the future.
- **Suspend** manually (reason required). **Reactivate without payment** gives access until a chosen date (at most 30 days) with a reason.
- Suspension never deletes anything. The company keeps Billing, Help & Support, data export and read-only document download.

## Changes and cancellation
- **Change package / cycle / amount**: apply now (limits change today) or at the next renewal. A cycle change needs the new agreed amount. Nothing is prorated or charged automatically.
- **Cancel**: access continues to the paid-through date unless you tick *end access immediately*. Data is kept.

## Reports
**Export Excel (.xlsx)** downloads the register with the current filters: License Register, Payment History, License Activity, Summary and About (time and filters). Every export is recorded.

## Launch migration
**Launch migration** lists companies activated before licenses existed: **Adopt** turns the record into an active license keeping its paid-through date (no payment is recorded). **Bulk assignment**: paste `orgId,planId,billingCycle,currency,amount,startDate` lines, **Preview** (changes nothing), then **Assign valid rows** (each starts awaiting its first payment).
