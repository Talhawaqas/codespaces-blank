# AI-Powered Business Operations — Controlled AI Actions

Internal architecture doc for the SOW `Inaya_AI_Controlled_Actions_SOW.md`. Same honesty
convention as `docs/backup-redundancy-architecture.md`/`docs/chain-agnostic-audit.md`: every claim
below cites a real file, real function, or a real passing test — nothing here is aspirational, and
anything genuinely deferred is labeled as such rather than implied to exist.

Core principle (the SOW's own words, and the one sentence that governs every design choice below):

> **AI recommends. Humans authorize. The server validates. The system executes. The audit trail
> remembers.**

## What already existed before this pass

A materially large part of this SOW turned out to already be built, real, and working — this pass
is an *extension*, not new architecture:

- **Phase 1 (Action Framework) / Phase 3 (Server-Side Permission Validation) / Phase 6 (Guarded
  Execution) / Phase 11 (API Design)**: `src/lib/ai-action-requests.js` — a complete
  `PENDING_APPROVAL → APPROVED (36h delay) → QUEUED → EXECUTED|EXPIRED` state machine, with
  idempotency (hour-bucketed hash key) and an atomic per-request claim (`APPROVED→QUEUED`
  `findOneAndUpdate`) that makes overlapping cron runs replay-safe. API surface:
  `src/app/api/orgs/ai-actions/route.js` (list), `.../[requestId]/review/route.js` (approve/reject),
  `.../[requestId]/cancel/route.js` (cancel), `src/app/api/cron/execute-approved-ai-actions/route.js`
  (the executor cron).
- **Phase 7 (Activity & Audit Logging)**: `src/lib/auditChain.js`, shipped 2026-08-31 (confirmed via
  `git log`) — a real sha256 hash chain (`entryHash = sha256(prevHash + canonicalFields)`),
  `verifyChainIntegrity()` re-walks and recomputes the whole chain, a real admin UI
  (`src/app/admin/audit/page.js`) and a verifiable JSON/CSV export (`/api/admin/audit/export`),
  tested in `test/audit-chain.test.mjs`. Every AI action request state transition already writes
  through `logOrgActivity()`, which feeds this chain.
- **Phase 9 (Multi-Tenant Isolation)**: every collection query in `ai-action-requests.js` and every
  domain workflow file is `orgId`-scoped; `requireMembership()` gates every `/api/orgs/*` route.
  Proven directly in this pass by test #4 in `test/ai-action-requests-security.test.mjs` (a record
  from org A never resolves under org B's `orgId`).
- **Phase 12 (UI)**: `src/components/business/AIActionRequestsView.js` — fully generic over
  `targetRecordType`, needed zero structural changes to support the new domains below.
- **Phase 13 (Integration With Existing AI)**: `src/lib/ai-business-tools.js`'s Gemini
  function-calling layer — every mutating tool was already a `propose_*` tool that never calls a
  real transition function directly.

## What this pass added

**Phase 4 (Controlled AI Actions) — 7 new domains wired into the existing pipeline.** Every domain
below already had a real, working transition-function state machine
(`{from,to,requiresManage,activityAction}` + one atomic `findOneAndUpdate`) — this pass only added
the guarded-execution wrapper around each, replicating exactly what `TASK`/`EXPENSE` already had:

| targetRecordType | Real transition function | New `propose_*` tool |
|---|---|---|
| `DOCUMENT` | `transitionDocument` (`document-workflow.js`) | `propose_document_transition` |
| `EMPLOYEE` | `transitionEmployee` (`employee-workflow.js`) | `propose_employee_transition` |
| `INVOICE` | `transitionInvoice` (`invoice-workflow.js`) | `propose_invoice_decision` |
| `LEAVE_REQUEST` | `transitionLeaveRequest` (`leave-workflow.js`) | `propose_leave_decision` |
| `PURCHASE_ORDER` | `transitionPurchaseOrder` (`purchase-order-workflow.js`) | `propose_purchase_order_transition` |
| `PURCHASE_REQUEST` | `transitionPurchaseRequest` (`purchase-request-workflow.js`) | `propose_purchase_request_transition` |
| `DEAL` | `transitionDeal` (`deal-workflow.js`) | `propose_deal_transition` |

Each one adds exactly 4 pieces, same as the existing `TASK`/`EXPENSE` pair: an `EXECUTORS` entry
(`ai-action-requests.js`), a `resolveCanApprove()` case (now in its own module, see below), a
`propose_*` tool function + Gemini declaration (`ai-business-tools.js`), and nothing else — the
review UI and the executor cron needed no changes.

**`resolveCanApprove()` extracted into `src/lib/ai-action-approval-gate.js`.** Previously inline in
the review route; moved so it has no dependency on `next/server` and can be unit-tested directly
(`node --test`) rather than only through an HTTP round-trip. Behavior is unchanged — the route still
imports and calls it exactly as before.

**Phase 5 (Action Risk Classification).** `classifyRisk(targetRecordType, proposedAction)` in
`ai-action-requests.js`, computed and stored (`riskLevel`) at proposal time. Grounded in the SOW's
own examples: LOW = task changes, document submit/revise, deal advance/regress. MEDIUM = document
review actions, deal close/reopen, purchase-request submit/cancel, leave decisions, employee
onboarding/leave changes. HIGH = expense/invoice/purchase-order decisions, purchase-request
approve/reject, employee termination. Surfaced in `AIActionRequestsView.js` as a badge, with an
inline warning line for HIGH-risk pending requests. Unrecognized combinations default to MEDIUM,
never silently LOW.

**Phase 10 (Action Expiration).** `PROPOSAL_EXPIRY_MS` (7 days) + `proposalExpiresAt` (set at
proposal time) + `expireStalePendingActions()`, called from the existing daily cron alongside
`executeApprovedAiActions()` — no new cron entry. Distinct from the existing post-approval
`unlockAt` delay: this expires an *unreviewed* proposal. `reviewAiAction()` also gained a
synchronous backstop — an expired-but-unswept `PENDING_APPROVAL` row cannot be approved even before
the daily sweep runs (tested: security suite #6).

**Phase 8 (AI Safety Boundaries).** `businessSystemInstruction()` in `ai-business-tools.js` now
states the SOW's CAN/CANNOT list explicitly, names every `propose_*` tool by name, and instructs the
model to refuse and continue treating any instruction (from the user, a document, or elsewhere) that
asks it to skip approval or claim a proposal already executed. No new enforcement mechanism — this
was already structurally guaranteed by `ctx.scope` (permission-filtered read data) and `canPropose`
(re-derived from the real domain gate, never the model's own claim); Phase 8 here is about making the
boundary explicit in the prompt, not inventing a new check.

**Org self-service audit verification** (not in the original SOW phases — added mid-implementation
after the client asked whether business customers could check Guarded Execution / the audit trail
themselves). `AIActionRequestsView.js` already was self-service (any active member). The audit
trail was not — `/admin/audit` is internal-admin-only. Added the customer-facing equivalent, reusing
the exact same verified `auditChain.js` functions: `GET /api/orgs/audit` and
`/api/orgs/audit/export` (owner/admin only — the chain spans every department, so this is
compliance-sensitive breadth beyond a single department member's default view), and
`src/components/business/AuditTrailView.js`, wired into the Business Workspace nav as "Audit Trail"
next to "AI Action Requests."

## Explicit scope boundary — verified absent, not just ungated

The SOW's Phase 4 wishlist includes several actions that do not exist anywhere in this codebase
today, gated or not: AI-driven record **creation** (a new task, contact, or a generic
HR/finance/procurement "task"), task **reassignment**, transaction **categorization**, and
drafting/sending customer **communications**. Confirmed by direct search — no `createTask`,
`createContact`, or assignee-change function exists in any workflow module, and no communication-
sending mechanism exists in this codebase at all. Building guarded actions for these means inventing
new business-mutation functions first, a materially larger scope than "extend the controlled-action
layer to existing state machines." This is the SOW's own Phase 17 ("Future Guarded Execution")
territory, not attempted here. `receivePurchaseOrder()` (quantity-payload receipt, real inventory
stock movement) is also deliberately excluded from `PURCHASE_ORDER`'s guarded actions — different
shape than a fixed `{from,to}` transition.

Read-only Phase 4 asks (supplier comparison, anomaly identification, report generation) needed no
new guarded action — they're already served by `list_suppliers` and `get_business_insights`, since
they never mutate anything.

## Testing (Phase 14 / 15)

- `test/ai-action-requests.test.mjs` — 8 unit tests: risk classification, idempotency dedup, the
  approve/reject/cancel state machine, atomic-claim replay safety under real concurrent invocation,
  and proposal expiration. All passing against real Atlas.
- `test/ai-action-requests-security.test.mjs` — 11 tests, one per SOW Phase 14 attack scenario
  (execute without confirmation, forge confirmation, bypass role permissions, cross-tenant access,
  replay an old confirmation, execute an expired proposal, alter an action after confirmation,
  escalate privileges, prompt injection into AI context, arbitrary server execution, duplicate
  actions under real concurrency). All passing against real Atlas.
- Regression: `test/audit-chain.test.mjs` still passes unmodified; `npx next build` stays clean.

`executeApprovedAiActions`/`expireStalePendingActions` gained an optional `{ orgId }` parameter
*purely for test isolation* — the real cron route still calls both with no arguments, so production
behavior (system-wide sweep) is unchanged; tests pass their fixture `orgId` so they never touch
another org's genuinely-due request on a shared database.

## Phase 16 (Testnet / Staging Deployment) — not yet done

This pass shipped the code and its test coverage. A real end-to-end staging run — a live user
confirming a real proposal for each of the 9 domains, watching the 36h delay, and inspecting the
resulting audit-chain entries in the new self-service Audit Trail tab — has not yet been performed
and should happen before this is called fully done, matching this repo's "every deployed piece gets
a real proof" convention established by the Backup & Recovery and multichain bridge work.
