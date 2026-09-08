# Government & Public Sector Sovereign OS SOW — Phase 6, Production Readiness

Covers §21 Phase 6 for `INAYA NETWORK — GOVERNMENT & PUBLIC SECTOR SOVEREIGN OS` SOW. Builds on
Phase 1's plan (`.claude/plans` — Government OS Foundation) and Phases 2-5, folded into the same
implementation pass per the user's explicit "include all phases" instruction. Same honesty
convention as every SOW in this codebase: what's real is stated as real, what's a business/legal
activity (not engineering) is named as such, never implied as "done" by shipping code.

## What shipped, by phase

- **Phase 1 (Foundation)**: `government` vertical registered; `canManageGovernment`/
  `canAccessGovernment`/`isCitizenRecordAssignee` gates; `citizen-records.js` (assignment-based
  need-to-know access, mirroring Health OS's care-team precedent exactly); `government-cases.js`
  (6-state case workflow, linkable to citizen records); a government-only stricter
  chain-of-custody hook on document reads (not just writes); `policy-knowledge-base.js` (reusing
  `compliance-policies.js`'s publish-immutable lifecycle); `ai-government-tools.js` (100% read-only,
  need-to-know enforced inside the tool layer, not just the API layer); new collections/indexes;
  full API route set under `/api/orgs/government/*`; `GovernmentView.js` UI wired into the
  Business Workspace nav and org-creation flow.
- **Phase 2 (Operations)**: confirmed Procurement/Contracts/Finance/HR/Tasks/Approvals need zero
  new engineering — they're already vertical-agnostic. New work: `government-dashboard.js`
  (operations + security readiness KPIs, "unknown never fabricated as passing" discipline) and
  `government-procurement.js` (an explicitly informational, non-binding competitive-bid threshold
  flag — real jurisdiction-specific procurement law is out of this codebase's scope to hard-code).
- **Phase 3 (Government AI)**: delivered as part of Phase 1's `ai-government-tools.js` — 6 tools,
  zero mutations, wired into `ai-os-router.js` alongside every other vertical's tool set.
- **Phase 4 (Security & Compliance Readiness)**: confirmed the platform-level Security Layer,
  audit chain, and `compliance-*.js` modules already apply to government orgs with zero new
  primitives needed — `government-dashboard.js` (built for Phase 2) doubles as this phase's
  readiness dashboard, surfacing audit chain integrity and unreviewed break-glass grants.
- **Phase 5 (Integrations)**: 5 new stub-by-default integration providers (civil registry, legacy
  government ERP, GIS/land records, public records portal, interagency data exchange) added to the
  already cross-vertical `integrations.js` catalog — `configured:false` until a real connection is
  ever made, same honesty boundary as every other provider in that file. A real pilot-agency
  onboarding is a business/operations activity, not engineering — not attempted here.

## Test coverage

New test files: `test/citizen-records.test.mjs` (the load-bearing assignment-required-access
property, including cross-org isolation and duplicate/merge handling), `test/government-cases.test.mjs`
(transition legality, citizen-record-link access inheritance), `test/policy-knowledge-base.test.mjs`
(the load-bearing publish-immutability property), `test/government-dashboard.test.mjs` (the
load-bearing "unknown is never fabricated as passing" property), `test/ai-government-tools.test.mjs`
(zero mutation tools, prohibited-query refusals, need-to-know enforced inside the tool layer).
`test/vertical-lock-wiring.test.mjs` extended to statically verify every government route actually
locks to the `government` vertical using the same `orgId` expression it authenticated with.

Existing `test/privileged-access.test.mjs` already covers break-glass's immediate-log/expiry/
mandatory-review property generically — Government reuses `privileged-access.js` completely
unchanged (it was already built cross-vertical during the Financial/Regulated Enterprise SOW), so
no separate government-specific break-glass test was needed.

## Production readiness assessment (§21 Phase 6 categories)

| Category | Status |
|---|---|
| Performance | New collections are indexed on every query pattern used (`orgId+status`, `orgId+recordId+email` uniqueness for assignments, etc.) — same indexing discipline as every prior vertical. No load testing performed (out of scope for this pass, same as every prior SOW here). |
| Security review | **Required before production use** — this pass's own adversarial reasoning (need-to-know tested at both the API and AI-tool layers, cross-org isolation tested, publish-immutability tested) is real but is not a substitute for an independent reviewer who didn't write the code. |
| Disaster recovery / backups | Inherits the platform's existing MongoDB backup posture — no government-specific DR work was in scope for this pass. |
| Runbooks | Not written — same reasoning as the Trust Fabric SOW's Phase 6: writing a runbook for a feature with no live pilot agency yet would be speculative, not real. |
| Records retention | `retention.js`'s `isUnderLegalHold()`/`checkDispositionAllowed()` are available for government records to use, but no government-specific retention SCHEDULE was authored — real records-retention schedules are jurisdiction- and agency-specific, not something this codebase should invent. |
| Required third-party certification/authorization (§3, §7 Phase 6) | **Explicitly NOT engineering work.** No FedRAMP, accreditation, classified-data authorization, or jurisdiction-specific compliance claim is made anywhere in this implementation's UI copy, code comments, or this document. That requires separate authorities and independent assessors entirely outside this codebase's ability to provide. |

## Verification performed

- `npm test` (full `inaya-network-dapp` suite) run after every new module — see the session's own
  test output for the exact pass count; this doc does not restate a number that could go stale the
  moment another test is added elsewhere in the repo.
- Every new API route confirmed statically locked to the `government` vertical via the extended
  `vertical-lock-wiring.test.mjs`.
- The two load-bearing correctness properties (`citizen-record access requires actual assignment`,
  `a published policy KB entry is never mutated in place`) each have a dedicated test proving the
  property, matching this codebase's established "write the test first, confirm it would fail on a
  naive draft" discipline for its most important guarantees.

## What this SOW does NOT claim

No claim of government certification, FedRAMP authorization, accreditation, or compliance with any
specific jurisdiction's public-sector regulations is made anywhere in this codebase. This is an
engineering/product implementation, per the SOW's own closing note — certification, legal
authorization, and jurisdiction-specific compliance are separate workstreams requiring relevant
authorities and independent assessors, not something a codebase change can provide.
