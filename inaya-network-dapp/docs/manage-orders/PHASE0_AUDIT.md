# Manage Orders SOW — Phase 0 Audit (INAYA-BOS-WO-RO-TECH-OPS-SOW-2026-V1)

Audited 25 Nov 2026 against `inaya-network-dapp` (main @ 092c35f) and `inaya-mobile` (main @ 715d5b9). Audit only: no code changed.

## 1. Constraints that shape everything

| Constraint | Effect on this SOW |
|---|---|
| MongoDB Atlas is at its 500-collection limit | No new collections. New records live in the existing multi-kind collection `calendar_records` with a `kind` field, the pattern Commerce and Workforce already use (`src/lib/commerce/store.js` `ccol()`, `src/lib/workforce/time.js`). |
| Mobile ships by OTA only (we never push or build inaya-mobile) | OTA can change JavaScript screens, not native modules. The app has **no camera, image-picker, location or barcode module** today (`package.json`). It has `expo-document-picker`, `expo-file-system`, `expo-notifications`, `expo-secure-store`. |
| No server-side mobile push for Business OS | `expo-notifications` is installed but nothing on the server sends Business OS pushes. Notifications are in-app (`src/lib/notifications.js`, real collection with read state). |
| Release gate (SOW 2.1) | Every capability must pass live E2E before customers see it. |

## 2. Reuse matrix (existing capability → decision)

| Need | Existing | Decision |
|---|---|---|
| Company/branch isolation | `orgs.js` membership; branches = `warehouses`; `workforce/scope.js` (`memberLocations`, `scopeFilter`, `allowedLocation`), `workforce/branchGuard.js` | **Reuse** on every WO/RO/scheduler/cheque query |
| Roles | `role` owner/admin/member + `commerceRole`, `financeRole`, `hrRole`, `supportRole`; `ROLE_TEMPLATES` | **Extend**: add `opsRole` (technician / dispatcher / manager / service_advisor / storekeeper) to the same member record and role templates. No new permission system |
| Attendance, breaks, corrections | `workforce/time.js`: idempotent punches (CLOCK_IN, BREAK_START/END, CLOCK_OUT), server time, corrections approved by another manager, timesheets, shifts, availability, swaps | **Reuse as-is** for SOW 9.1A and mobile clock-in. Only add a mobile-friendly API wrapper |
| Shifts / availability / leave | `w_shift`, `w_avail` in `workforce/time.js`; `leave-workflow.js` | **Reuse** for scheduler availability |
| Employees, skills | `employees` collection (HR) | **Extend** with technician profile (skills, certifications + expiry, eligible job categories) stored as kind `ops_tech` keyed by member email |
| Stock reserve / consume / return | `inventory.js` (`recordStockMovement`, `reserveStock`, `releaseStock`, `withStockTransaction`), append-only ledger | **Reuse**; add `relatedJobId` metadata on movements. No job stock ledger |
| Purchase orders | `purchase-order-workflow.js` (8-state machine, receiving into inventory), `purchase-request-workflow.js`, suppliers | **Reuse**: PO register reads `purchaseOrders`; WO/RO→PO link stored on the job |
| Customer / CRM | `crm_contacts`, `crm-activity.js` | **Reuse** for RO customer |
| Customer assets (vehicles, devices) | None generic (`ict-asset-inventory.js` is the company's own ICT assets) | **New** kind `ops_asset` |
| Invoices / tax | `invoices` + `computeInvoiceTotals` + `invoice-workflow.js` (same path Sales Orders use to raise invoices) ; ledger auto-posts from invoices (`ledger.js` `syncLedger`) | **Reuse**: RO "Invoice" raises one invoice through the same engine, `relatedRepairOrderId`, locked against double invoicing |
| Payables / payments | `expenses` (DRAFT→PENDING_APPROVAL→APPROVED), `payments` (OUTGOING + `relatedExpenseId`), ledger posts AP→Cash | **Reuse**: a cheque is created from an APPROVED expense; issuing it records one `payments` row (method `cheque`, reference = cheque number) |
| Bank reconciliation | AI Bookkeeper `bookkeeper/reconcile.js` + bank import (reads `CHECKNUM` from OFX) | **Reuse**: cheque reconciliation links to the matched bank transaction |
| Approvals | per-module state machines; `ai-action-approval-gate.js`; `/api/orgs/pending-approvals` feed | **Reuse** the state-machine + pending-approvals pattern |
| Audit | `org-activity-log.js`, `commerce/store.js audit()` | **Reuse**; append-only events, corrections as new events |
| Documents / evidence | encrypted upload + `attachments.js`, `chunkedStorage.js` | **Reuse** for job photos/evidence |
| Notifications | `notifications.js` (dedupe keys) | **Reuse**; mobile reads the same feed |
| Recurring jobs (PM) | `workflows/schedule.js` + cron infrastructure | **Reuse** for preventive-maintenance generation |
| Printing | browser print + desktop app print (`commerce/desktopPrint.js`) | **Reuse** for cheque print |
| Mobile Business OS | `src/screens/business/*` (HR, Inventory, Procurement, Tasks, Finance…), session via `BusinessSessionContext` | **Extend**: new Technician screens in the same stack |
| Navigation | `src/lib/navigation/navItems.js`, `business-nav.js` | **Extend**: one "Manage Orders" entry |

## 3. Proposed model (all in `calendar_records`, `kind` prefix `ops_`)

- `ops_wo` Work Order and `ops_ro` Repair Order: number (WO-/RO- via existing `nextNumber`), branch (`warehouseId`), status, priority, dates, checklist, required skills, parts lines (productId, qty, reserved, consumed, returned), labour estimate, assignments `[{email, lead, from, to}]`, links (contactId, assetId, poIds, invoiceId, expenseIds), history.
- `ops_asset` customer asset (type, make, model, serial/registration, warranty, contactId).
- `ops_estimate` RO estimate versions + customer authorisation (actor, time, accepted version).
- `ops_act` job activity events (ACK, START, PAUSE+reason, RESUME, SUBMIT, INSPECT_PASS/FAIL, CLOSE), idempotency key unique, server time, device/app version; corrections are new events.
- `ops_tech` technician profile; `ops_site` site QR/code; `ops_exc` manager exception + resolution.
- `ops_chqbook`, `ops_chqtpl`, `ops_chq` cheque book / template / cheque (+ print, reprint, void events inside).
- Unique partial indexes: number per org+kind, act idempotency, cheque number per book, one active cheque per expense.

State machines exactly as SOW 5.3 (WO and RO separate), server-validated tables like `purchase-order-workflow.js`.

## 4. Requirements that can't be delivered as written (without your decision)

1. **Camera photos, barcode/QR scanning and GPS on mobile** need native modules → a new app build, not OTA.
2. **Server push to phones** isn't built for Business OS; v1 can use in-app notifications the app checks while open.
3. **Physical cheque printing** can only be verified with a real cheque leaf from your pilot bank and a real printer.
4. **Live E2E before release**: there is no separate staging database for Vercel previews today.

## 5. Phased plan (batches)

1. Foundation: `opsRole`, technician profiles, Manage Orders nav + four registers (PO register over existing POs), shared list/detail, plan gate.
2. Work Orders end to end (lifecycle, checklist, parts reserve/consume/return, inspection, PM templates).
3. Repair Orders (intake, asset, diagnosis, estimate versions, customer authorisation, change orders, QC, invoice once, history).
4. Scheduler + technician chart (calendar, lanes, unassigned/overdue, conflicts + override reason, eligibility from shifts/leave/skills/branch).
5. Attendance/job verification + exception queue (thresholds, site code, review actions; no automatic penalties).
6. Mobile technician screens (home, clock, My Jobs, lifecycle, notes, checklist, evidence, parts request) by OTA.
7. Cheques (books, templates with mm positions + alignment print, approval, print/reprint/void, payment row, reconciliation link).
8. Reports + hardening + full regression + live E2E evidence report.

Acceptance matrix = SOW 22.1–22.9, one automated test file per batch on the test database plus browser E2E.
