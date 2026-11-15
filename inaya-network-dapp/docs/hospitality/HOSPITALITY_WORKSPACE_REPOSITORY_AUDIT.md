# Hospitality & Food Service Workspace: repository audit (Phase 0)

Date: 2026-11-14. Read-only audit of `inaya-network-dapp` against the Hospitality SOW. Nothing was changed while this was written.

Status labels: **Verified existing** · **Existing but incomplete** · **Code present, external integration unverified** · **Not found** · **Requires product decision**.

## 1. Existing modules and where they live

| SOW need | Status | Where |
|---|---|---|
| Industry mode locked to one business type | Verified existing | `src/lib/industry-config.js` (`ORG_VERTICALS`, `requireVertical`). Seven verticals today; Education OS is the newest and the pattern to copy |
| Session, org membership, server-side authorization | Verified existing | `src/lib/orgs.js` (`requireMembership`, `getOrgCollections`), `src/lib/orgGates.js` (per-module role fields on `org_members`) |
| CRM contacts, activity, lead score | Verified existing | `crm_contacts`, `src/lib/crm-activity.js`, `/api/orgs/crm` |
| Inventory: products, warehouses, stock levels, movements, transfers | Verified existing | `src/lib/inventory.js` (`recordStockMovement`, `transferStock`, `isLowStock`), `/api/orgs/inventory` |
| Batch and expiry tracking, earliest-expiry-first | Verified existing | `src/lib/inventory-lots.js` |
| Purchase and stock units, barcodes | Verified existing | `src/lib/inventory-units.js` |
| Reorder suggestions and draft purchase requests | Verified existing | `src/lib/inventory-reorder.js` (`suggestedReorderQuantity`, `draftReorderRequest`, `runAutoReorder`) |
| Recipes (bill of materials) | Verified existing | `src/lib/production.js` (`saveBom`, `requirementsFor`, `shortages`), `boms` collection. Built for manufacturing: one BOM per stock product |
| Suppliers, purchase requests, purchase orders, receiving, approvals | Verified existing | `src/lib/purchase-request-workflow.js`, `purchase-order-workflow.js` (`receivePurchaseOrder`), `supplier-scorecard.js`, `/api/orgs/procurement` |
| Finance: invoices, expenses, ledger, AI Bookkeeper | Verified existing | `src/lib/ledger.js`, `invoice-workflow.js`, `expense-workflow.js`, `src/lib/bookkeeper/` |
| HR: employees, leave, org chart | Verified existing | `employees`, `leave_requests`, `src/lib/hr-structure.js`, `leave-workflow.js` |
| Staff shifts / roster | **Not found** | No shift model anywhere (`health-scheduling.js` is patient scheduling) |
| Tasks and projects | Verified existing | `tasks`, `src/lib/task-workflow.js` |
| Documents and attachments (client-side encrypted) | Verified existing | `org_documents`, `src/lib/attachments.js` |
| Appointment calendar, availability, public booking page, reminders, ICS feeds | Verified existing | `src/lib/engagement/` (`appointments.js`, `availability.js`, `booking.js`, `reminders.js`, `feeds.js`, `time.js`) |
| Table / seating model, table conflict rules, waitlist | **Not found** | Appointments are per staff member, not per table or capacity |
| Email campaigns: templates, segments, approval, scheduling, test send | Verified existing | `src/lib/engagement/campaigns.js`, `templates.js`, `segments.js`, `sender.js`, `sequences.js` |
| Consent, suppression, unsubscribe | Verified existing | `src/lib/engagement/suppression.js` (`recordConsent`, `isSuppressed`, `unsubscribeByToken`) |
| Bulk email provider (Resend) with bounce/complaint webhook | **Code present, external integration unverified** | `sender.js`, `/api/webhooks/resend-marketing`. Marketing subdomain DNS and webhook secret are not set up yet |
| Transactional email | Verified existing | `src/lib/email.js`, live |
| SMS reminders (Twilio) | **Code present, external integration unverified** | `src/lib/smsProviders`. Not configured (no paid subscription) |
| No-code workflow engine with event triggers | Verified existing | `src/lib/workflows/` (`queue.js` `emitWorkflowEvent`, `templates.js`, `nodes.js`) |
| Notifications (in-app, email) | Verified existing | `src/lib/notifications.js`, `business-notify.js` |
| AI assistant with permission-scoped tools per industry | Verified existing | `src/lib/ai-os-router.js`, `ai-education-tools.js` (the pattern) |
| Document Intelligence | Verified existing | `src/lib/docIntelligence/` |
| Business Insights | Verified existing | `src/lib/business-insights.js` |
| Tamper-evident audit chain | Verified existing | `src/lib/auditChain.js` (`appendAuditEntry`) |
| Evidence Graph / business events / Digital Twin | Verified existing | `src/lib/businessEvents.js`, `evidence.js`, `digitalTwin.js` |
| Integrations area, encrypted credentials, OAuth, webhooks | Verified existing | `src/lib/integrations.js`, `integrationCrypto.js`, `integrationOauth.js`, `src/lib/webhooks/` |
| POS integration | **Not found** | No POS connector. Stays "Planned" |
| Google / Outlook calendar sync | **Not found** (by design) | ICS feed out and secret iCal URL in, because Google verification wasn't possible |
| Payment gateway for deposits | **Not found** | Stripe code exists only for Inaya's own billing |
| Rate limiting for public endpoints | Verified existing | `src/lib/rateLimit.js` |
| Feature flags | Verified existing | `src/lib/featureFlags.js` |
| Service incidents | **Existing but incomplete** | `src/lib/incidents.js` is a security-incident register (its categories and states don't fit guest complaints) |
| Opening / closing checklists | **Not found** | HR onboarding checklists exist but are per employee |
| Menu catalogue, modifiers, allergens | **Not found** | |
| Wastage records with reasons and approval | **Not found** | Stock can be adjusted, but there's no wastage record or reason |
| Restaurant locations with hours and policies | **Not found** | `warehouses` are stock locations only |

## 2. Reusable APIs and data models

- `/api/orgs/crm`, `/inventory`, `/procurement`, `/hr`, `/tasks`, `/campaigns`, `/appointments`, `/workflows`, `/incidents`, `/insights`: used as they are. Hospitality links to them and doesn't copy them.
- `products` + `stock_levels` + `stock_movements` + `stock_lots`: ingredients are ordinary products. Wastage posts an `ADJUSTMENT` movement through `recordStockMovement`, so stock stays consistent.
- `purchase_requests`: reorder suggestions call the existing `draftReorderRequest`, which goes through the existing approval flow.
- `purchase_orders`: receiving uses the existing `receivePurchaseOrder`; a discrepancy record is added beside it.
- `crm_contacts`: the guest record. Reservations reference `contactId`.
- `marketing_records`: consent and suppression per email.
- Education OS: one catch-all route (`/api/orgs/education/[[...path]]`), role field on the member, a single view with ERP sections, AI tool file, wiring test. Hospitality follows the same shape.

## 3. UI and design system

- Business Workspace shell: `src/app/business` + `src/components/business/*View.js`; ERP layout in `src/lib/navigation/erpModules.js`, sidebar in `navItems.js`, launcher in `launcher.js`.
- Closest existing screens: `AppointmentsView.js` (day/week time grid), `EducationView.js` (sectioned industry view), `InventoryView.js`.

## 4. Permission and scoping patterns

- Every route: `requireMembership(req, orgId)` then `requireVertical(orgId, "<vertical>")`; `test/vertical-lock-wiring.test.mjs` enforces it.
- Roles are optional fields on `org_members` (`educationRole`, `calendarRole`, `marketingRole`…). Owners and admins manage everything.
- Need-to-know access to single records uses assignment lists (`isClassTeacher`). Location scoping for hospitality will use the same idea: a list of allowed location ids on the member.

## 5. Notifications and email

- Transactional email is live. Marketing email code is complete, but the Resend marketing subdomain, webhook and secret are still owed, so delivery events aren't verified in production.
- SMS is off (Twilio not configured).

## 6. Calendar

- Exists (appointments). Hospitality reservations are a different shape (table and capacity, not staff availability), but live in the same `calendar_records` collection and reuse its time-zone helpers, token hashing, reminders cron and ICS code.

## 7. Missing capabilities (to build)

Locations with hours and policies; seating areas and tables; reservation lifecycle with table assignment and conflict prevention; waitlist; public reservation page; menu catalogue with modifiers, allergens and recipe mapping; wastage with reasons and approval; receiving discrepancies; shift roster and swaps; opening/closing checklists; service incidents; hospitality reports; hospitality AI tools; workflow events and templates; integration status page.

## 8. Conflicts and architectural risks

1. **Atlas is at its collection limit** (491 collections in this database, 501 in the cluster; the limit is 500). No new collection can be created. Following the founder's 13 November ruling for the Appointments SOW ("never add more"), every hospitality record is stored in the existing `calendar_records` collection under `h_*` kinds. Guest consent stays in `marketing_records`. No new collection, no paid upgrade.
2. **No multi-document transactions are used anywhere.** Table double-booking is prevented with a unique index on slot-lock documents (one per table per 15-minute slot), which is safe under simultaneous requests.
3. **Warehouses are not restaurant locations.** A location may point to a warehouse (`warehouseId`) but neither is derived from the other; existing warehouse records are untouched.
4. **BOMs are one per stock product.** Dishes are not stock products, so recipes are stored on the menu item and reference ingredient products. The manufacturing BOM module is left unchanged.
5. **Marketing email provider is unverified.** The integration page must show it as "Configured, not verified" until the founder finishes the Resend setup.
6. **Pilot interviews (SOW §28) can't be done from the repository.** They're owed by the founder; the build follows the SOW and the limitations file records this.

## 9. Test commands and baseline

- Tests: `npm test` (node test runner, `test/*.test.mjs`, 313 files). Build: `npx next build`.
- Baseline results are in `HOSPITALITY_WORKSPACE_TEST_REPORT.md`.

## 10. Implementation sequence

1. Foundation: `hospitality` vertical, roles, location scoping, storage helpers, audit, navigation.
2. Reservations: locations, areas, tables, lifecycle, slot locks, waitlist, CRM linking, confirmation and reminder emails, public reservation page.
3. Menu and stock: catalogue, modifiers, allergens, recipes, wastage, reorder hand-off, receiving discrepancies.
4. Daily operations: shifts and swaps, checklists, incidents.
5. Campaigns: consent captured at booking, guest segments (visit recency), links into the existing Campaigns module.
6. AI tools, workflow events and templates, reports, integration status.
7. Tests, documentation, pilot notes.

## Decisions taken from existing precedent (flagged for the founder)

| Decision | Basis |
|---|---|
| Hospitality is an 8th industry mode, "Hospitality OS" | Same as Education, Legal, Healthcare |
| No new database collection | Founder ruling of 13 November; Atlas limit |
| Roles: manager, host, service, kitchen, stock; marketing and finance keep their existing roles | SOW §3.2 mapped onto the existing role-field pattern |
| No POS, payments, KDS, payroll, loyalty | SOW §4.2 |
| Bot protection on the public page is a honeypot field plus rate limits, not a paid CAPTCHA | No paid subscriptions |
