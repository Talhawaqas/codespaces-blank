# Inaya Evidence Graph & Trusted Business Event Layer

**Status:** Implemented and tested. **Date:** September 2026.

## 1. Phase 0 — Gap & Reuse Audit

A repository audit was performed before writing any code (see this document's own history — no implementation preceded it). Findings:

| Capability | Status before this SOW | Reused as-is |
|---|---|---|
| AI Controlled Actions / Guarded Execution (`ai-action-requests.js`) | Fully built: real 36h settlement delay, risk classification, 11 action domains | Yes — referenced by ID, never duplicated |
| Cryptographic audit chain (`auditChain.js`) | Fully built: `sha256(prevHash + canonicalFields)`, `verifyChainIntegrity`, `listAuditChain` | Yes — every existing workflow transition (`logOrgActivity`) already writes into it; a Business Event's "proof" is a query into this chain, not a second one |
| Invoices / Purchase Orders / Purchase Requests / CRM Deals / Suppliers | Fully built, independently | Yes — referenced, never copied |
| Generic "Approval" abstraction | **Did not exist** — approval was implicit in each domain's own state machine | New: Business Event provides the connecting pointer from "who approved" to "what was approved," without adding a second approval mechanism |
| Invoice ↔ Purchase Order linkage | **Did not exist** — invoices have no `poId` field | Not added to invoices' own schema (would be an unjustified schema change to a stable file); a Business Event links them via its own `relationships` array instead |
| Compliance Evidence Exporter (`evidenceExporter.js`, `evidencePdf.js`) | Fully built: canonical-hash JSON+PDF export | Yes — the Business Event Passport reuses its exact `canonicalizeForExport` hashing technique, not a second convention |
| Business Brief / Activity Center / Unified Search / Notifications / Trust Health | All fully built, all hardcoded-list or free-string extension points (only Unified Search is a true registry) | Extended additively in every case — see §3 |
| "What If" / simulation | **Did not exist anywhere in the codebase** (verified by grep — the SOW's own claim that one existed was not substantiated) | New: `businessEventSimulate.js` |
| "Business Event" / "Evidence Graph" | **Did not exist** — zero matches in the codebase | New — this SOW's actual deliverable |

## 2. What Was Built

- **`src/lib/businessEvents.js`** — the `BusinessEvent` core: references an existing invoice, purchase order, purchase request, or AI action request by `{subjectType, subjectId}`; never copies the subject. Department-scoped (or org-manager-only for AI-action subjects with no resolvable department), matching the exact visibility rule every other Business Operations record already uses. Typed relationships (`RELATES_TO`, `SOURCED_FROM`, `APPROVED_BY`, etc.) link additional evidence. Every mutation flows through the existing `logOrgActivity`, which already writes both the human-readable activity feed and the cryptographic audit chain.
- **`src/lib/businessEventExplain.js`** — the `Why?` view. Every field is either a real stored value (an AI action request's `proposedAction`/`riskLevel`/`requestedContextSummary` — never internal model reasoning, because none is persisted) or a re-derivation of a permission check this codebase already performs. Evidence resolution is permission-aware: an inaccessible linked record reports `RESTRICTED` with no leaked content, never a silent omission.
- **`src/lib/businessEventPassport.js`** — the Business Event Passport (JSON + PDF), reusing `evidenceExporter.js`'s exact canonicalization/hashing convention so the two features never diverge on what "the same data" hashes to. `verifyBusinessEventPassport()` independently recomputes the manifest hash and re-verifies the organization's live audit chain, returning `VERIFIED | INVALID | INCOMPLETE | UNKNOWN` — never a silent pass on missing data.
- **`src/lib/businessEventSimulate.js`** — What If / Simulation. Re-derives transition legality and authorization using the exact same state tables (`PO_TRANSITIONS`, `PR_TRANSITIONS`) and permission gates (`canAccessDepartment`, `canManageOrg`) the real transition functions use, without ever importing or calling those real functions. Verified by an adversarial test suite that snapshots the subject document before and after simulation and asserts byte-for-byte equality — the SOW's own explicitly named strongest acceptance test (§32).
- **API**: `GET/POST /api/orgs/business-events`, `GET /api/orgs/business-events/:id` (detail + timeline), `POST /api/orgs/business-events/:id/relationships`, `GET /api/orgs/business-events/:id/why`, `GET /api/orgs/business-events/:id/passport?format=json|pdf`, `POST /api/orgs/business-events/:id/verify`, `POST /api/orgs/business-events/:id/simulate`.
- **UI**: a new "Evidence" surface in the Business Workspace (`src/components/business/BusinessEventsView.js`) — list, timeline, Why?, What If (explicitly labeled "SIMULATION ONLY — NO CHANGES WERE MADE"), and Passport download.

## 3. OS Integration (all additive, no existing behavior changed)

- **`document-permissions.js`** — `getAccessibleScope()` now resolves `visibleBusinessEvents`, department/org-manager scoped exactly like every other array it returns.
- **`orgSearch.js`** — one new `ENTITY_SOURCES` row; a `subjectLabel` field was added to the Business Event document itself so the existing top-level-field-only `matchText()` can find it.
- **`activityCenter.js`** — one new bullets function surfacing real counts (HIGH-risk events opened, passports generated this period) into the existing "What Changed?" digest.
- **`trust-health-v2.js`** — the existing `audit_integrity` dimension now also reports a real, queried count of unresolved HIGH-risk Business Events, rather than a new eleventh dimension (preserving this file's own documented ten-dimension contract).
- **Notifications** — org owners/admins (other than the creator) are notified when a HIGH-risk Business Event is opened, via the existing free-string-category `createNotification`.

## 4. Testing

Three new real, database-backed `node:test` suites (`test/business-events.test.mjs`, `test/business-event-passport.test.mjs`, `test/business-event-simulate.test.mjs`), 16 tests total, all passing against the live dev database:

- Event creation references (never copies) the subject; risk classification matches the existing `classifyRisk` table.
- Department-scoped and cross-org access are both rejected correctly.
- Relationship evidence is permission-aware: an inaccessible linked supplier reports `RESTRICTED` with no leaked name.
- Timeline aggregation picks up real activity from a genuine workflow transition (`transitionPurchaseOrder`), not just from Business Event's own writes.
- A HIGH-risk event notifies other org managers, never the creator.
- A generated Passport verifies `VERIFIED`; tampering with any field flips it to `INVALID`; a missing hash reports `INCOMPLETE`; the rendered PDF is a real, non-trivial `%PDF`-signed file.
- **The critical simulation test**: approving a pending PO, an unauthorized approval attempt, an illegal transition, and approving a pending AI action request (verifying the real 36h delay is computed correctly) all leave the subject document byte-for-byte unchanged. A simulation's audit entry is written only against the `BUSINESS_EVENT` record, never against the subject's own `recordType`/`recordId` — so it can never be confused with a real transition in that record's own history.

Existing regression suites touched by this SOW's shared-file edits (`document-permissions.test.mjs`, 27 tests; `trust-health-v2.test.mjs`, 4 tests) — all still passing, zero regressions. A full production build (`npm run build`) completes cleanly with all seven new API routes compiled.

## 5. Known Limitations / Explicitly Deferred

- **Cross-organization Business Event sharing/privacy primitives** — not built. This SOW's own Digital Twin companion SOW covers cross-org privacy-preserving queries in depth; duplicating that research here would be premature.
- **A dedicated graph visualization** — not built, per the SOW's own §27 guidance that this should come after the underlying model and timeline are proven, and its own explicit warning against building a visual graph "that lacks verifiable underlying relationships." The timeline and Why? views are the verifiable substrate that visualization would sit on top of, when built.
- **Full 15-stage literal lifecycle** (§9) — scoped down to four real, derivable statuses (`OPEN`/`DECIDED`/`EXECUTED`/`CLOSED`), computed from each subject type's own real state machine rather than an independent 15-value enum that could drift from it.
- **Business Brief integration** — not extended in this pass; Activity Center and Trust Health integration were prioritized as the higher-value, cheaper touchpoints per the audit.
- **Batch/bulk simulation, event-type registry beyond the four subject types this codebase has real workflows for** — not built; additive when a genuine sixth or seventh domain gets its own workflow.

No AWS/regulatory/certification claims are made anywhere in this work. No existing test suite regressed.
