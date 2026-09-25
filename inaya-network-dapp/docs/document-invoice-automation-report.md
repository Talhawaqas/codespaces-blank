# Native Document & Invoice Automation Engine — Completion Report

Status: implemented in full and tested (see §5). Last verified: 2026-09-25.
Deployment and live-site smoke-test results are recorded in §8 once complete.

This report replaces the first-pass version, which covered invoices only, with
one fixed layout, no address fields and no Brief/Search integration. Those
gaps are closed; §6 lists what remains genuinely limited and why.

## 1. What the engine is

One pipeline serves every document type:

```
Inaya data -> Template -> Calculation -> Document -> Validation -> Approval
   -> Evidence -> Encrypted storage -> Secure delivery -> Verification
```

Nine document types run through it — invoice (standard and professional
layouts), purchase order, quotation, receipt, customer statement, credit
note, debit note, delivery note and business report — via a registry of
adapters, templates, validators, calculation and approval policies. Nothing
in the pipeline branches on a document type name.

## 2. Phase 0 reuse (nothing rebuilt)

| Existing capability | Reused as |
|---|---|
| Finance invoices, CRM contacts/deals, Procurement POs and payments | Source of truth for every document (read-only adapters) |
| `canManageFinance` and department/permission gates, Segregation-of-Duties checker | Gates for generate / approve / deliver / view, per type |
| Audit chain (`logOrgActivity`) | Every evidence node is also written to the org's cryptographic audit chain |
| Evidence Graph (`businessEvents.js`) | New subject type `GENERATED_DOCUMENT`; documents link SOURCED_FROM / DERIVED_FROM / PROVEN_BY |
| `s3-compat/store.js` `putS3Object` | Server-managed AES-256-GCM, sharding, pinning; gained an optional `providerName` |
| Object Lock / retention | Applied to finalized documents |
| `document-permissions.js` share tokens | Secure link delivery |
| External Data Room identity (`external-data-room.js`) | Identity-verified delivery (new room type `document_delivery`) |
| Guarded AI execution (`ai-action-requests.js`) | AI proposals generate a DRAFT that a human must still approve |
| Search, Business Brief, Activity Center, trust health, evidence exporter | Extended additively to see documents, permission-aware |

## 3. SOW capability → implementation → tests

| Capability | Implementation | Verified by |
|---|---|---|
| Exact money: decimal parsing, currency exponents (USD/EUR/GBP/AED/PKR = 2, JPY = 0, KWD/BHD/OMR = 3), rounding modes, pro-rata discount allocation | `money.js`, `calculations.js` | unit (money, edge-case vectors, pro-rata sums, determinism) |
| Commercial terms: line discounts, invoice discount, per-line tax, shipping, fees, payment terms, currency, per-invoice shipping address | `calculations.js`, `invoiceTerms.js`, invoice routes, `adapters.js` | types (full commercial-terms invoice) |
| Customer and organization details: billing/shipping addresses, tax id, payment terms, logo, brand colour, legal name | CRM routes + `CRMView.js`, `settings.js` billing profile, `adapters.js` | types (billing profile flows onto documents) |
| Nine document types with type-specific rules (approved-only PO, quotation from deal, receipt from approved payment, statement with running balance, credit ≤ invoice, partial delivery, permission-scoped report) | `adapters.js`, `documentTypes.js`, `validators.js` | types |
| Safe template language: blocks, `{{field\|format}}` from a whitelist, controlled conditions, currency configuration, size/depth limits, no code execution, no template injection | `templateSchema.js` | unit (system templates valid; malicious specs rejected; conditions; currency config) |
| Versioned templates: clone → draft → publish (atomic, immutable) → archive; ten system templates | `templateStore.js`, `systemTemplates.js` | types (template versioning) |
| Rendering: multi-page tables with repeated headers, A4/Letter, margins, footers, page numbers, DRAFT watermark, byte-reproducible output | `renderer.js` | unit (renderer), lifecycle (reproduced hash on retry) |
| Languages: en-US, en-GB, ar-AE, ur-PK, fr-FR, de-DE, es-ES; RTL layout, Arabic shaping and bidi, bundled Noto Sans and Noto Sans Arabic (OFL) | `i18n.js`, `renderer.js`, `fonts/` | unit (localization), types (Arabic AED and Urdu PKR, French Letter) |
| Atomic numbering: per org, type and fiscal year; configurable prefix/separator/padding/reset; never reused; ledger with reasons for cancelled/void/failed | `numbering.js`, `settings.js` | unit (concurrency, formats, ledger), lifecycle (terminal states keep numbers accounted for) |
| Validation with explainable rules (`id`, severity, rule, inputs), including prompt-injection detection in source text | `validators.js` | types, security (injection) |
| Approval: thresholds per type, exact-version binding, Segregation of Duties, stale-source drift check, superseded/expiry refusal, non-human actors refused, draft render for approver and final re-render with stamp | `lifecycle.js`, `settings.js` | security (approval integrity, replay/concurrency), e2e ($25,000 scenario) |
| Finalization: re-verify stored bytes, sealed manifest, evidence root, retention lock, supersede older versions and revoke their links | `lifecycle.js`, `manifest.js`, `storage.js` | lifecycle (fails closed on tampered store), e2e |
| Idempotent generation: claim-row-first under unique indexes, client or derived keys, `forceNewVersion`, stale-claim resume | `pipeline.js` | lifecycle (idempotency incl. simultaneous duplicates) |
| Honest failure states: `GENERATION_FAILED`, `STORAGE_FAILED`, `EVIDENCE_PENDING`, `DELIVERY_FAILED`; automatic retry with backoff (5 attempts); no document is complete unless stored and evidenced | `pipeline.js`, `jobs.js` | lifecycle (storage outage, renderer failure, evidence gap, delivery failure, provider fallback) |
| Evidence: hash-chained per-document nodes, audit-chain entry per node, Evidence Graph link, evidence root in manifest | `evidence.js` | security (tampering detected), e2e |
| Storage: per-org bucket with Versioning and Object Lock, encrypted, provider fallback across configured pinning providers | `storage.js`, `s3-compat/store.js` | lifecycle (fallback), e2e (real providers) |
| Delivery: secure link (256-bit token, hash stored, expiry, max uses, revocation, version+hash binding, access log including denials) and identity-verified Data Room | `delivery.js`, `external-data-room.js` | security (enumeration, expiry, revocation, max uses, isolation, version confusion), e2e (Data Room) |
| Verification: public verify (minimal fields), authenticated deep verify (recompute hashes, chains, decrypt stored copy), Document Passport (JSON/PDF, internal/external scope, sealed) | `verify.js`, `/verify-document` | security (forged passport), e2e |
| AI: explainability (inputs, checks, rules, evidence); advisory summary that cannot change a number; AI proposals generate a draft only | `aiAssist.js`, `ai-business-tools.js`, `ai-action-requests.js` | lifecycle (AI), security (injection) |
| Integration: Unified Search, Business Brief, Activity Center, trust health, evidence exporter, pending approvals, invoice PAID/CANCELLED sync | `visibility.js`, `orgSearch.js`, `business-brief.js`, `activityCenter.js`, `trustHealth.js`, `evidenceExporter.js`, `invoice-workflow.js` | lifecycle (permission-aware integration), regression suites |
| Security: org isolation, IDOR (404 not 403 for others' ids), rate limits, input bounds, path traversal, Mongo operator injection, markup and formula injection in source text | all routes, `_lib.js` | security suite |
| Observability: durations, sizes, failures, retries, queue latency; no confidential content recorded | `metrics.js` | lifecycle (observability) |
| UI: Documents / Create / Templates / Settings / Verify / Health tabs, approval and delivery views, public shared-document, verify and Data Room pages | `DocumentAutomationView.js`, `documents/*`, pages | `npm run build` (§5) |
| Operations: hourly cron, runbook, user and developer documentation | `/api/cron/document-automation`, `docs/document-automation-runbook.md`, `content/docs/*` | docs-content test |

## 4. Bugs found and fixed by this SOW's own testing

- **Arabic rendering.** The font layer reversed glyphs per script run and misplaced spaces; `+` printed as a missing-glyph box. Fixed with word-atomic bidi layout, explicit spaces and per-character font fallback.
- **PKR shown with 0 decimals** (ICU default). Fixed by forcing currency-table precision.
- **First evidence node never written.** Claim rows carry `evidenceSeq: 0`, which the append filter did not match, leaving documents in `EVIDENCE_PENDING`. Fixed the filter.
- **Template hash mismatch.** MongoDB stores `undefined` as `null`, so hashes taken before storage differed from those recomputed later. Everything hashed and stored now goes through `jsonSafe()`.
- **Silent fallbacks removed.** An invalid business-report period and an unsupported locale both used to fall back silently; both now return 400.
- **Denied link attempts were not logged.** Expired, revoked and over-limit attempts now write `DENIED` access events.
- **Recovery jobs re-processed.** A queued recovery job stayed pending after its document had already recovered through another path; jobs are now closed on recovery.
- **Recipient masking leaked short addresses.** The masking pattern needed two characters before `@`, so `r@acme.example` was stored in full. Fixed.
- **AI summary injection guard.** A prompt injection inside a line-item description did not stop the model call, because only the summary facts were scanned. The validator's finding now also blocks the model, and "no model configured" is reported explicitly.
- **Hardening.** A membership from another organization is refused by the view check; non-string line descriptions are rejected.
- **External risk found:** the Pinata plan limit (`HTTP 403 ... plan usage limit`) blocked storage during testing. Storage now falls back across configured providers; the plan itself still needs attention (see §6).

## 5. Test results

Real MongoDB, no mocks of application logic. Tests run with `RESEND_API_KEY=` and `GEMINI_API_KEY=` emptied so no real email or AI calls are made.

| Suite | Result |
|---|---|
| `document-automation-unit` (money, calculations, numbering, hashes, templates, localization, renderer) | 20 tests, all passed in the first run; none of its code paths changed afterwards |
| `document-automation-types` (nine document types, templates, preview) | 13 / 13 |
| `document-automation-lifecycle` (idempotency, failure states, retries, void/cancel/expiry, search/brief/activity, AI) | 13 / 13 |
| `document-automation-security` (isolation, IDOR, links, replay, approval integrity, injection, tampering, exhaustion) | 10 / 10 |
| `document-automation-e2e` ($25,000 acceptance scenario, Data Room, supersession, real providers) | 3 / 3 |
| Regression: finance, CRM, business events, event passport, event simulate | 35 / 35 |
| Regression: docs content, evidence, guarded execution (12), AI action requests (+security), document permissions, activity, org trust, trust health | all passed |
| Regression: evidence exporter | 3 passed, 2 failed for an external reason: both failing tests write a test object through the existing S3-compatible layer, and Pinata rejects the pin with `HTTP 403 ... Account blocked due to plan usage limit`. The failure is in the pre-existing storage path (which this SOW did not change), not in the exporter's new `documentAutomationEvidence` section. It will pass once the Pinata plan is restored. |
| `npm run build` | Compiled successfully; all new routes and pages (`/verify-document`, `/shared-document/[token]`, `/document-room/[token]`, the `documents-automation` API tree) are in the build output |

The live deployment checks are recorded in §8.

## 6. Honest limits

- **Signatures are approval stamps** naming the approver and time. They are not PKI or e-signature certificates.
- **Scripts outside Latin, Greek, Cyrillic and Arabic** (for example Chinese, Japanese, Korean, Hebrew) are flagged by validation and may print blank until more fonts are bundled.
- **A secure link is bearer access.** The recipient's email is recorded, not verified. Only the Data Room delivery verifies identity through a magic link.
- **Credit and debit notes are documents that reference a real invoice.** Inaya's Finance module has no credit ledger, so issuing one does not change the invoice's recorded balance.
- **Byte-identical re-rendering holds on the same runtime.** The Node/ICU version is recorded in each manifest because date and number text can differ across ICU versions.
- **Storage bounds generation.** With every pinning provider down, generation fails honestly (`STORAGE_FAILED`) and recovers later. The Pinata plan is at its usage limit; the engine falls back to Filebase, but the plan should be upgraded so there is real redundancy.
- **Rendering runs inside the API request** (bounded to 200 pages and 20 s). Very large batches should be spread out or moved to a queue.
- **Email is notification-only.** With no `RESEND_API_KEY`, a delivery records `NOT_CONFIGURED` and the sender shares the link manually.
- **Google Sign-In is not used** for external recipients; the Data Room magic link is the identity path.

## 7. Deployment notes

- No new required environment variables. `CRON_SECRET` is needed for the new hourly cron `/api/cron/document-automation` (`vercel.json` now has 18 crons).
- `next.config.mjs` traces the bundled fonts into the document, invoice, cron and AI-execution functions (`outputFileTracingIncludes`). If tracing failed in production the renderer would fall back to Helvetica and report `unicodeFonts:false`; the live smoke test checks for this.
- New MongoDB collections and indexes (`documentTemplates`, `documentTemplateCounters`, `documentNumberLedger`, `documentAutomationSettings`, `documentDeliveries`, `documentAccessEvents`, `documentJobs`, `documentMetrics`, plus unique idempotency, series and ledger indexes) are created by the existing `ensureOrgIndexes()` path.
- The legacy `generate-document` invoice route is kept as a thin wrapper over the new pipeline, so existing callers and the invoice modal keep working. The old HTML print route is untouched.

## 8. Deployment and live verification

- Commit `ed59fc2` pushed to `main`; Vercel production deployment `codespaces-blank-19koo6pz6` reached **Ready** (2 min build).
- **Verified live (unauthenticated, 2026-09-25):** `/verify-document` and `/shared-document/<token>` pages load (200); every authenticated document API returns 401 without a session; a bad delivery token returns 404 "This link is invalid."; the cron endpoint rejects a caller without `CRON_SECRET` (401); the public verify endpoint validates its input (400 without a PDF).
- **Not verified live:** generating a PDF on the production site. That path needs a signed-in session, and no session was available in the test environment. The same code is exercised by the 3 e2e tests and the type/lifecycle suites locally (including Arabic and Urdu), but font tracing into the Vercel function (`outputFileTracingIncludes`) has not yet been confirmed in production. Check: sign in, open Business → Document Automation → Create, choose any invoice and press Preview. If the fonts were not traced, the renderer falls back to Helvetica, records `unicodeFonts:false` in the renderer info, and Arabic text would print blank.
