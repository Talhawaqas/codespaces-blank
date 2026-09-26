# AI Bookkeeper: Phase 0 Capability Audit

SOW: *AI Finance & Bookkeeping Automation Layer*. Audited 2026-09-26 against `main` (commit `8f5477c`). Status vocabulary: **Existing / Reusable / Partial / Missing / External dependency / Unverified**.

## 1. What exists (and is reused, not rebuilt)

| SOW area | Status | Where | Decision |
|---|---|---|---|
| Invoices (customer invoices) | Existing | `invoices` (`src/app/api/orgs/finance/invoices`, `src/lib/invoice-workflow.js`): `invoiceNumber, contactId, lineItems, subtotal, total, currency, status DRAFT/SENT/PAID/OVERDUE/CANCELLED`, cron-driven overdue | Authoritative. Bookkeeper references it; "paid" only through the existing `INVOICE` transition. |
| Expenses | Existing (Partial) | `expenses`, `src/lib/expense-workflow.js`: `vendor, category, amount, currency (fixed "USD"), status DRAFT/PENDING_APPROVAL/APPROVED/REJECTED`, attachments route | Authoritative for expenses. Gap: currency is fixed to USD at creation. |
| Payments | Existing (Partial) | `payments`: `direction INCOMING/OUTGOING, amount, currency (fixed "USD"), relatedInvoiceId/ExpenseId/PurchaseOrderId, status RECORDED/APPROVED`, approve route | Authoritative for recorded payments. Same USD-only gap. |
| Vendors / customers | Existing | `suppliers` (name, contactEmail), `crm_contacts`, `vendor_records` (regulated) | Matched by name/email/alias; no parallel vendor table. |
| Purchase orders, requests | Existing | `purchase_orders` (`items[{description, quantity, unitPrice, receivedQuantity, productId}]`, `supplierId`, status through PARTIALLY_RECEIVED/RECEIVED) | Three-way match reads PO items and `receivedQuantity`. |
| Inventory / receipts | Existing | `products`, `stock_levels`, `stock_movements`, PO receiving | Receipt leg of three-way match. |
| Permissions | Existing | `canAccessFinance`, `canManageFinance`, `canAccessDepartment`, `getAccessibleScope` | No second permission system. Every bookkeeper record carries `departmentId`. |
| Controlled actions | Existing | `proposeAiAction`, `reviewAiAction`, 36 h delay; executors already exist for `INVOICE` and `EXPENSE` | Consequential steps (mark invoice paid, approve expense) are proposed through these, unchanged. No second approval engine. |
| Audit chain | Existing | `logOrgActivity` (hash chained) | Reused; new record type `BOOKKEEPING`. |
| Evidence Graph, Passport | Existing | `businessEvents.js` (subject types, relationships), `businessEventPassport.js` | New subject type `BOOKKEEPING_ITEM`; passport export reused. |
| Notifications | Existing | `createNotification` | Permission-scoped: only finance-capable members. |
| Business Insights | Existing | `computeBusinessInsights` with `getAccessibleScope` | Adds a `bookkeeping` block from validated records, scoped the same way. No second KPI engine. |
| AI gateway | Existing | `gatedJson` in `src/lib/support/ai.js` (input security check, output validation, retries, redaction) | Reused for extraction/categorization proposals. AI stays non-authoritative. |
| Storage of files | Existing | `storeSupportObject` (encrypted org object store with Pinata to Filebase fallback), 25 MB chunked upload pattern, `scanFile` (static + ClamAV/Cloudmersive) | Reused for source files; scanner reused for malware/safety checks. |
| Email intake | Reusable / Unverified | Support inbound email (Resend/Svix signature verification, signed routing address) | Same verified-signature adapter pattern for a finance inbox. Live Resend inbound is still unverified. |
| Workflows / scheduler | Existing | AI Business Operations Manager (`src/lib/workflows`, `/api/cron/workflows`), tool registry `TOOLS`, template builder | Bookkeeper exposes tools and one Finance Operations Manager template. No second scheduler. |
| Digital Twin | Existing | `simulateDigitalTwinScenario`, `SCENARIO_HANDLERS` | Three read-only finance scenarios added, output labelled **SIMULATED. NOT A LIVE FINANCIAL RECORD**. |
| Multi-currency | Existing (static) | `src/lib/currency.js`: USD, EUR, GBP, AED, PKR at a fixed dated table (`RATES_AS_OF`) | Reused. No invented live FX; conversions record source and date. |
| Exports / reports | Partial | `finance/reports` route (CSV), Passport PDF, pdfkit | CSV reports built on the same conventions; XLSX and PDF only where a library exists (PDF via pdfkit; **no XLSX library**, so XLSX is not offered). |

## 2. Genuine gaps (implemented in this SOW)

| Gap | Status | Plan |
|---|---|---|
| Bank transactions, CSV / OFX / QIF import | **Missing** | Provider-neutral source abstraction, real CSV/OFX parsers, duplicate-safe import. |
| Bank-feed provider (Plaid, open banking) | **External dependency** | Adapter interface only. Not claimed as live. No provider account exists. |
| OCR / document extraction | **Missing** | Text PDFs and text documents: deterministic extraction. Images and scanned PDFs: model-based extraction through the AI gateway, labelled as requiring an AI provider; every field carries provenance and confidence; deterministic validation (totals, dates, currency) gates the result. |
| WhatsApp ingestion | **Missing / External dependency** | Meta WhatsApp Cloud API webhook adapter (verify token, HMAC signature, replay guard, media fetch). UNVERIFIED live: needs a WhatsApp Business account. |
| Email ingestion connectors (Gmail, M365, IMAP) | **Missing / External dependency** | Signed inbound-email adapter (reuses the Resend/Svix path) plus generic authenticated API ingestion. Gmail/M365/IMAP polling connectors are FUTURE. |
| Categorization, matching, reconciliation, review, anomaly, rules | **Missing** | New `src/lib/bookkeeper/*`. The only existing "reconciliation" (`referral-reconciliation.js`) is unrelated. |
| General ledger / double-entry / journal posting | **Missing** | **Not built.** No chart of accounts or ledger exists, and the SOW forbids inventing a partial accounting system. "Posted" means: applied to the existing authoritative records (expense created and approved, payment recorded, invoice marked paid) through the existing workflows. Journal entries are documented as an open gap. |
| Multi-currency on payments and expenses | **Partial** | Existing records are USD-only at creation. Matching compares the original currency of the bank transaction with the invoice's own currency and records any conversion separately; a payment in another currency is matched but flagged for review, never silently converted. |
| Period-close | **Missing** | Checklist workflow only. No statutory close is claimed. |

## 3. Architecture decisions

1. **Authority.** Invoices, expenses, payments, POs remain authoritative. Bookkeeper tables hold *proposals and evidence* (documents, bank transactions, matches, review items, rules, reconciliations). A confirmed match is a proposal that becomes a change only through the existing transitions.
2. **Confidence and policy.** Four separate scores (extraction, categorization, match, anomaly). Auto-processing needs every configured dimension at or above its threshold (default 0.99) **and** no policy violation **and** no anomaly **and** risk below the auto limit (amount thresholds, high-risk categories, new vendor, currency mismatch). Risk overrides confidence.
3. **What "auto-process" is allowed to do.** Low-risk internal state only: categorization label, match linkage, review-queue clearing, reconciliation status. Anything that changes an authoritative financial record (mark invoice paid, approve expense, create payment) goes through `proposeAiAction` and a human plus the standard delay. This is the "never let an LLM mutate financial records" rule made structural.
4. **Determinism first.** Matching hierarchy is exactly the SOW order (external reference, invoice number, amount+currency, party, date window, PO, history, fuzzy); the AI only proposes, and never overrides a deterministic conflict.
5. **Untrusted content.** Document text is data: passed to the model inside untrusted tags with instructions stripped, output validated against a schema and re-checked deterministically, never executed as tool calls.
6. **Idempotency.** Unique indexes on (org, source, externalId), content SHA-256, provider event ids; repeated sync, upload, webhook, OCR retry and match job create nothing new.
7. **Isolation.** Every collection and query filters by `orgId`; department scope is enforced with `canAccessDepartment` / `getAccessibleScope`; notifications go only to finance-capable members.
8. **Currency.** Original amount and currency always preserved; conversions use `currency.js` with the rate table date recorded; unsupported pairs are flagged, never guessed.

## 4. Verification plan (what will be labelled what)

| Item | Will be labelled |
|---|---|
| CSV/OFX import, categorization, matching, reconciliation, review queue, anomaly, evidence, audit, insights, twin, security tests | VERIFIED by automated tests on a real database |
| Text-PDF and text extraction | VERIFIED with test documents |
| Image / scanned extraction | Depends on the configured AI model; verified with real sample images only if the model is reachable, otherwise UNVERIFIED |
| Email (signed inbound) | UNVERIFIED live (real Resend inbound not yet configured) |
| WhatsApp | UNVERIFIED (no WhatsApp Business account) |
| Bank-feed providers | External dependency, not implemented beyond the adapter interface |
| Journal posting | Missing, not claimed |
