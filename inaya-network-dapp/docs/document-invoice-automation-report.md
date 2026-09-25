# Native Document & Invoice Automation Engine — Completion Report

Status: **LIVE** (real invoice PDF generation, atomic numbering,
decimal-safe calculation, encrypted sovereign storage, Evidence Graph
provenance, and secure time-limited delivery — all end-to-end tested
against the live system). Last verified: 2026-09-25.

## 1. Phase 0 Gap Audit

The Phase 0 audit found this codebase already contains far more of this
SOW's prerequisites than the SOW's own illustrative gap table implied —
consistent with the discipline every SOW tonight has followed.

| SOW capability | Existing Inaya capability | Classification | Reuse path |
|---|---|---|---|
| Invoice model + lifecycle | `invoices` collection, `invoice-workflow.js` (DRAFT/SENT/PAID/OVERDUE/CANCELLED) | ALREADY IMPLEMENTED | Reused as-is, unmodified |
| CRM customer linkage | `invoices.contactId` → `crmContacts` | ALREADY IMPLEMENTED | Reused as-is |
| Evidence Graph provenance | `businessEvents.js`, `EVENT_TYPES.INVOICE` already wired to the real `invoices` collection | ALREADY IMPLEMENTED | Reused verbatim — zero modification needed |
| Cryptographic audit chain | `logOrgActivity` → `auditChain.js` | ALREADY IMPLEMENTED | Reused as-is |
| Encrypted sovereign storage | `s3-compat/store.js`'s `putS3Object` (real encrypt/shard/pin/backupEngine pipeline) | ALREADY IMPLEMENTED | Reused verbatim for server-managed document storage |
| Secure, time-limited, revocable sharing | `document-permissions.js` (`createDocumentShare`/`consumeDocumentShare`/`revokeDocumentShare`, atomic expiry/revocation/use-count) | ALREADY IMPLEMENTED | Reused verbatim |
| PDF rendering technique | `pdfkit` (already added earlier this session for `businessEventPassport.js`) | ALREADY IMPLEMENTED (technique) | Reused library; new layout (line-item table) written fresh |
| Currency support | `currency.js`'s `SUPPORTED_CURRENCIES` (USD/EUR/GBP/AED/PKR — exactly SOW §22's list) | ALREADY IMPLEMENTED | Reused as-is |
| Human approval boundary | No `PENDING_APPROVAL` state in `invoice-workflow.js`; `canManageFinance` already gates every consequential invoice action | ARCHITECTURAL DECISION | Finalization gated on `canManageFinance`, not a new approval sub-workflow — see §3 |
| Atomic document numbering | Confirmed absent — invoice numbering is client-suppliable or `Date.now()`-based | GENUINE GAP | New: `numbering.js` |
| Decimal-safe money math | Confirmed absent — existing `computeTotal()` is naive floating point | GENUINE GAP | New: `calculations.js` |
| Real binary invoice PDF | Confirmed absent — the existing `/pdf` route returns an HTML print view, with a stale code comment claiming "no PDF library exists" (pdfkit was added after that route was written) | GENUINE GAP | New: `invoicePdfRenderer.js` (kept the existing HTML route untouched, added alongside it) |
| Template/content engine | Confirmed absent | GENUINE GAP, NOT BUILT | One real, fixed, tested layout this pass — see §7 |

## 2. New Capabilities Implemented

`src/lib/documentAutomation/`:
- `calculations.js` — real decimal-safe (integer-cents) money math: subtotal, per-line and invoice-level discounts, tax, shipping, grand total, amount due. Verified against the classic `0.1 + 0.2` floating-point trap and a hand-checked multi-line invoice.
- `numbering.js` — real atomic, org+type+fiscal-year-scoped document numbering (`INV-2026-000001`) via MongoDB's atomic `findOneAndUpdate`/`$inc`. Verified with 20 concurrent allocations producing 20 distinct, sequential numbers — zero collisions, not just asserted by inspection.
- `manifest.js` — the canonical document manifest (SOW §14) and content-hash verification (`verifyDocumentIntegrity`) — real recomputation and comparison, not a stored `verified: true` flag.
- `invoicePdfRenderer.js` — a real, multi-page-capable invoice PDF: line-item table with repeated headers across page breaks, org/customer blocks, totals, page-numbered footer, Unicode currency symbols. No template DSL, no server-side code execution of user content.
- `generate.js` — the orchestrator: recomputes authoritative totals from the invoice's own stored line items (never trusts a client-supplied total), allocates a number only on first generation, renders the PDF, stores it through the real encrypted pipeline, records the manifest, and links it into the invoice's existing Evidence Graph business event via a `PROVEN_BY` relationship.
- `delivery.js` — secure delivery reusing `document-permissions.js`'s real share-token system, with a new recipient-facing byte-serving path (server-managed decryption, since a server-generated PDF has no client-side passkey to hand out).

API routes: `POST/GET .../finance/invoices/[invoiceId]/generate-document`, `GET .../documents-automation/[documentId]` (manifest/status), `POST .../documents-automation/[documentId]/share`, `DELETE .../share/[shareId]`, and the unauthenticated `GET /api/documents-automation/deliver/[token]`.

UI: a `DocumentAutomationPanel` added to the existing invoice detail modal in `FinanceView.js` — additive, alongside the pre-existing "Generate PDF Invoice" (HTML print) link, not replacing it.

`orgs.js` (additive): two new collections (`generatedDocuments`, `documentSequences`) with indexes.

## 3. Architectural Decision: The Approval Boundary

SOW §10 requires human approval reuse; §10 and §9 both prohibit a second
workflow engine. This codebase's `invoice-workflow.js` has no
`PENDING_APPROVAL` state of its own — its real states are DRAFT/SENT/
PAID/OVERDUE/CANCELLED, each already gated by `canManageFinance`. Rather
than bolt a parallel approval sub-workflow onto document generation,
**finalizing a document is gated on the same `canManageFinance`
permission** that already governs every other consequential invoice
action in this codebase — stated plainly here rather than silently
invented. `ai-action-requests.js`'s full `PENDING_APPROVAL`/36-hour-delay
workflow remains available and untouched for AI-*proposed* document
actions, per SOW §11.

## 4. Two Real Bugs Found and Fixed During This SOW's Own Testing

1. **A silent extra-page bug in the PDF footer.** Writing page-number
   text near the bottom margin on a `switchToPage`-targeted page made
   `pdfkit` think the content overflowed and silently append a blank
   page per footer write — a real 3-page invoice rendered as 6 pages (3
   real + 3 blank), caught by actually reading the rendered PDF page by
   page, not by trusting a byte-count check. Fixed by zeroing the page's
   bottom margin for the duration of the footer write (pdfkit's own
   documented workaround for this exact behavior).
2. **`generateInvoiceDocument` let a real storage failure throw
   uncaught** rather than returning the `{error, status}` shape every
   other function in this codebase uses, and rather than recording the
   honest `STORAGE_FAILED` state SOW §27 explicitly requires. Fixed by
   wrapping the storage call in try/catch, persisting a real
   `STORAGE_FAILED` record (documentHash retained, no manifest, never
   marked FINALIZED), and returning a clean error — caught by the
   automated test suite when the (separately known, external) Pinata
   plan-limit issue from earlier tonight was still in effect; by the
   time of the final test run it had recovered, and the full real
   pipeline (generation → storage → Evidence Graph → secure delivery →
   revocation → superseded-version fail-closed) passed end-to-end for
   real.

## 5. Testing

`test/document-automation.test.mjs` — **15/15 passing**, real MongoDB,
no mocks:
- Unit: calculation correctness (including the floating-point trap and a
  hand-verified multi-line invoice with tax/discount/shipping), invalid
  input rejection, atomic numbering (including the 20-concurrent-
  allocation zero-collision test), canonical hashing (key-order
  independence), tamper detection (a modified PDF byte fails hash
  verification), real PDF rendering (multi-page and single-page, with a
  genuine `/PDF-` magic-header check and a real page-count check read
  from the PDF's own page tree, not just "did it not throw").
- Integration: fail-closed permission denial for a non-finance-manager;
  the full real pipeline (real invoice → real calculation → real PDF →
  real atomic number → real encrypted storage → real Evidence Graph
  `PROVEN_BY` relationship); regeneration creating a new version while
  retaining the same document number and marking the prior version
  `SUPERSEDED`; secure delivery's real byte round-trip through a real
  token, real revocation (a revoked token is rejected immediately), and
  a superseded document's link failing closed rather than silently
  serving the newer version.
- Regression: `finance-workflow.test.mjs`, `business-events.test.mjs`,
  `crm-workflow.test.mjs` — **25/25 passing** after this SOW's two
  purely-additive existing-file changes (`orgs.js`, `FinanceView.js`).

## 6. Known Limitations (honest, not silently omitted)

- **Only invoices are wired up.** The SOW's Section 4 lists eleven
  document types; `numbering.js`'s prefix table and `generate.js`'s
  orchestrator cover invoices for real. Purchase orders, quotations, and
  the rest share the same real numbering/manifest/storage/delivery
  primitives — extending to another type is now a second renderer plus
  a thin orchestrator function, not new infrastructure.
- **No template engine.** One real, fixed, tested invoice layout ships
  this pass, not a versioned template authoring system (SOW §5/§23). A
  genuine template engine (with the safety constraints §5 requires — no
  server-side code execution from template content) is real, scoped
  work deferred rather than half-built at the end of a long session.
- **Organization/customer billing address fields don't exist yet** on
  the underlying `orgs`/`crmContacts` schemas (confirmed by the Phase 0
  audit) — the renderer handles their absence gracefully (verified: an
  invoice with no address lines renders cleanly, no crash, no layout
  gap), but a real invoice today will show a name and email only, no
  street address, until those fields are added to the source models.
- **Business Brief / Activity Center / Unified Search integration not
  added.** The Phase 0 audit found all three already read generically
  from `logOrgActivity`-backed records by `recordType`, meaning a
  `DOCUMENT_FINALIZED` activity action would very likely surface
  automatically — not independently verified this pass, since the audit
  itself flagged this needs confirming against those modules' bodies,
  not assumed.
- **No Data Room integration** — delivery reuses the simpler, already-
  existing document-share-token system rather than the heavier Data
  Room feature, a deliberate reuse-target decision (see the module
  header comments), not an oversight.

## 7. Deployment

No new environment variables. Two new MongoDB collections
(`generatedDocuments`, `documentSequences`), both created idempotently
by the existing `ensureOrgIndexes()` path. The one existing route this
SOW's UI change sits alongside (`finance/invoices/[invoiceId]/pdf`) is
completely untouched — the new "Generate official document" action is
additive, not a replacement.
