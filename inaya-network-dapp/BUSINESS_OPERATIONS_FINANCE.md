# Business Operations — Phase 5a: Finance

**Built:** August 26, 2026. Half of the "Inaya Finance & HR Layer" SOW — Invoices, Expenses, Payments, and CSV reporting. A **testnet demonstration/validation layer**, explicitly not regulated banking, tax filing, payroll processing, or real-money financial infrastructure (see SOW §8) — every finance screen carries a visible "Testnet / Beta" badge.

## Where it lives

- **Schema + indexes:** `src/lib/orgs.js` (`invoices`, `expenses`, `payments`, `attachments`)
- **Roles:** `canManageFinance()` / `canAccessFinance()` in `src/lib/orgs.js` — additive `financeRole: null | "manager" | "staff"` field on `org_members`, checked alongside (never replacing) the existing `canManageOrg()` gate
- **Workflows:** `src/lib/invoice-workflow.js` (`transitionInvoice()`, `markOverdueInvoices()`), `src/lib/expense-workflow.js` (`transitionExpense()`)
- **Attachments:** `src/lib/attachments.js` — shared with HR (see BUSINESS_OPERATIONS_HR.md), `relatedRecordType: "EXPENSE"` for receipts
- **API:** `src/app/api/orgs/finance/invoices/**`, `.../expenses/**` (incl. `[expenseId]/attachments`), `.../payments/**` (incl. `[paymentId]/approve`), `.../reports/route.js`
- **Cron:** `src/app/api/cron/invoices-mark-overdue/route.js` (`vercel.json`, `0 5 * * *`, `CRON_SECRET`-gated — same pattern as `checkpoint-reputation`/`rag-reingest`)
- **Dashboard:** `financeSummary` field in `src/app/api/orgs/dashboard/route.js`
- **AI tools:** `list_invoices`, `list_expenses` in `src/lib/ai-business-tools.js`
- **Web UI:** `src/components/business/FinanceView.js` (Invoices / Expenses / Payments / Reports tabs)
- **Mobile UI:** `inaya-mobile/src/screens/business/FinanceScreen.js` + `InvoiceDetailScreen.js`
- **Tests:** `test/finance-workflow.test.mjs`

## Data model

```
invoices     _id, orgId, departmentId, contactId (FK crm_contacts), invoiceNumber, issueDate, dueDate,
             lineItems:[{description,quantity,unitPrice}], subtotal, total, currency, status
             (DRAFT|SENT|PAID|OVERDUE|CANCELLED), notes, createdByEmail, createdAt, updatedAt, deletedAt

expenses     _id, orgId, departmentId, vendor, category, amount, currency, expenseDate, description,
             status (DRAFT|PENDING_APPROVAL|APPROVED|REJECTED|CANCELLED), createdByEmail, createdAt, updatedAt, deletedAt

payments     _id, orgId, departmentId, direction (INCOMING|OUTGOING), relatedInvoiceId (nullable),
             relatedExpenseId (nullable), amount, currency, method, paymentDate, status (RECORDED|APPROVED),
             createdByEmail, createdAt, deletedAt
```

An invoice's `contactId` FKs into the existing `crm_contacts` collection — the SOW's explicit "CRM → Customer → Invoice" integration point, not a duplicate customer concept.

## Workflows

Same `{from, to, requiresManage, activityAction}` transition-table pattern every prior Business Operations module uses (`task-workflow.js`, `purchase-order-workflow.js`, etc.):

```
invoice-workflow.js   send: DRAFT→SENT | markPaid: SENT|OVERDUE→PAID | cancel: DRAFT|SENT|OVERDUE→CANCELLED
                       SENT→OVERDUE is the ONE exception: cron-driven (markOverdueInvoices()), never a user action.
expense-workflow.js    submit: DRAFT→PENDING_APPROVAL | approve/reject: PENDING_APPROVAL→APPROVED|REJECTED
                        (requiresManage: canManageFinance) | cancel: DRAFT|PENDING_APPROVAL→CANCELLED
```

Payments have no state machine — `RECORDED` on insert, one `canManageFinance`-gated `approve` action flips it to `APPROVED` via an atomic `findOneAndUpdate({status:"RECORDED"})`, the same replay-safety pattern every other transition in this app uses even for a single-step flow.

## Permission model

`canAccessFinance` (Finance Staff or Manager, or org owner/admin) to view/create; `canManageFinance` (Finance Manager or org owner/admin) to approve expenses, approve payments, and move an invoice to PAID/CANCELLED. Every finance record stays department-scoped on top — a Finance Staff member only sees records in departments they can access (`canAccessDepartment`), unless they're also an org manager.

## The overdue cron

Unlike Tasks' `dueDate` (a computed `isOverdue` boolean with no stored transition), OVERDUE is a real, stored invoice status — dashboards and filters need it queryable. `markOverdueInvoices()` runs nightly, flips `SENT → OVERDUE` once `dueDate` passes, and is idempotent: a `PAID` invoice with a past `dueDate` is never touched, because the cron's filter is `status: "SENT"`, not "dueDate in the past."

## Reports

`GET /api/orgs/finance/reports?type=revenue|expenses|outstanding|paid-unpaid&format=json|csv`. CSV is hand-built (`csvEscape`/`toCsv` — no runtime CSV/PDF library exists anywhere in this app, confirmed before writing this route; a small manual string builder needs no new dependency, matching this codebase's consistent preference for hand-rolling small utilities). PDF export is explicitly out of scope — see below.

## Verified, not just written

- `node --env-file=.env.local --test test/finance-workflow.test.mjs` — 8/8 passing against real Atlas: full invoice lifecycle (send→markPaid), the cron's overdue-flip AND its idempotency (a PAID invoice with a past due date is never re-touched), org-isolation (an org B caller 404s on an org A invoice), a Finance Staff member correctly denied every state-changing transition, the expense submit→approve gate (Staff denied, Manager allowed) with a matching `org_activity` entry, and payment record→approve with replay-safety (a second approval attempt on an already-APPROVED payment is a clean no-op, not a duplicate).
- `npm run build` — production build compiles cleanly with the new routes and `FinanceView.js`.

## Explicitly out of scope (this pass)

- No PDF invoice generation — no runtime PDF library exists anywhere in this app today; adding one is real new scope better done once there's an actual invoice-template design, not silently promised here.
- No multi-currency conversion — one currency label per record (defaults `"USD"`), stored as-entered.
- No regulated banking/payment-processor integration — payments are records of amounts, not real money movement, per the SOW's explicit testnet-scope instruction.
