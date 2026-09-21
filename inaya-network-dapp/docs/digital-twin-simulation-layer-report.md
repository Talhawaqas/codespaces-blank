# Inaya Digital Twin & Privacy-Preserving Organizational Simulation Layer

**Status:** Implemented and tested (single-org scope). **Date:** September 2026.

## Phase 0 Audit — What Already Existed

The Evidence Graph & Trusted Business Event Layer SOW, built immediately before this one in the same session, already delivered a real, tested, no-mutation-guaranteed simulation engine (`businessEventSimulate.js`) that answers "is this one record's transition legal and authorized." That is NOT the Digital Twin's job — this SOW's own genuine gap, confirmed by re-reading its own §2, is a **persistent, traversable dependency graph across the org's real entity landscape**, so a hypothetical change can be followed through to what else it touches, not just validated in isolation.

| Capability | Status before this SOW | Treatment |
|---|---|---|
| Single-record transition simulation (never mutates) | Fully built (Evidence Graph SOW's `businessEventSimulate.js`) | Reused as the design precedent, not rebuilt |
| Permission-aware evidence resolution with RESTRICTED/INCLUDED disclosure | Fully built (`businessEventExplain.js`) | Reused as the design precedent for `resolveDependents()` |
| Cryptographic audit chain | Fully built | Reused — every simulation logs one entry, never against the subject's own recordType |
| A persistent, cross-entity dependency graph | **Did not exist** | Built, computed on-demand from real existing foreign keys — no new graph database, per the SOW's own §24 storage-strategy preference |
| Named scenario simulations (supplier/employee/project/warehouse) | **Did not exist** | Built |
| Cross-org privacy-preserving queries | **Did not exist** | Evaluated (see the separate feasibility document below), not built — no validated use case exists yet |

## What Was Built

- **`src/lib/digitalTwin.js`** — the dependency graph. `resolveDependents()` finds direct dependents of one entity by querying the real foreign keys already on real records (a supplier's `_id` referenced by a PO's `supplierId`, a department's `_id` referenced by every department-scoped collection, a project's `_id` referenced by tasks/deals, a person's email referenced by task assignments and project memberships). `traverseDependencyGraph()` does a depth-bounded (default 3 hops) breadth-first walk from a starting entity, matching the SOW's own §61 performance guidance to prefer relevant-subgraph extraction over an unbounded walk. Every dependent is permission-filtered the same way `businessEventExplain.js` already does: a record in a department the caller can't access is reported as `RESTRICTED` (existence disclosed, content withheld), never silently dropped and never leaked in full.
- **`src/lib/digitalTwinSimulate.js`** — four named scenario simulations matching the SOW's own worked examples (§54-57): `SUPPLIER_UNAVAILABLE`, `EMPLOYEE_ACCESS_REMOVED`, `PROJECT_DELAYED`, `WAREHOUSE_UNAVAILABLE`. Each traverses the real dependency graph and reports only consequences a real stored field can back — a task's due date only shifts in the result if that task actually has a stored `dueDate`; nothing invents a completion-date shift for a purchase order or project, since neither has a stored completion-date field in this codebase. Everything else (external logistics, customer commitments, financial cost of delay) is explicitly reported `UNKNOWN` with the actual reason, never silently omitted or guessed at — the SOW's own §17/§31 rule that missing data must never become false certainty.
- **API**: `POST /api/orgs/digital-twin/simulate` — one route, dispatching on `scenarioType`, session-authenticated the same way every other org route in this codebase is.

## A Real Permission Gap Found and Fixed During Development

While building the warehouse scenario, testing found that `stockLevels` rows have no `departmentId` field of their own (confirmed via `inventory.js`) — the generic per-dependent permission check that works for every other entity type would have silently defaulted a stock-level row to visible regardless of which department the caller could actually access. Fixed by gating each scenario on the *starting* entity's own department (the warehouse's, the project's, the supplier's) before any traversal begins, and documented the limitation directly on `resolveDependents()` so a future caller doesn't reintroduce the same gap by exposing a raw "traverse anything" endpoint without the same check. Covered by a dedicated security test.

## Testing

`test/digital-twin.test.mjs` — 9 tests, all passing against the real database: dependency traversal correctness (a two-hop supplier → PO → product path), permission-aware `RESTRICTED` disclosure, cross-org isolation, correctness of all four scenario types (including the honest `UNKNOWN` reporting for unbacked fields), the warehouse permission-gap fix, and — the SOW's own explicitly named strongest test — a scenario across all four types that snapshots every collection read before and after and asserts byte-for-byte equality, plus confirms the only writes anywhere are `DIGITAL_TWIN_SIMULATION` audit entries, never anything against a subject's own recordType.

Production build compiles cleanly with the new route registered.

## Known Limitations / Explicitly Deferred

- **Cross-organization Digital Twins** — evaluated in a dedicated feasibility document (`docs/digital-twin-cross-org-privacy-feasibility.md`), recommendation: **Defer**. No validated business need exists yet; ZK/MPC/TEE would all be built speculatively, which the SOW's own §39 explicitly warns against.
- **Twin snapshots/reproducibility (§26)** — not built. The dependency graph is computed live from current state each time rather than versioned; a reproducible "what did the graph look like when this simulation ran" snapshot is deferred until a real audit/compliance need for it appears.
- **Graph visualization UI (§34)** — not built, per the SOW's own explicit guidance that visualization should come after the underlying model is proven, and its own warning against a visual graph "that lacks verifiable underlying relationships." The API and dependency-traversal logic are the verifiable substrate a future UI would sit on.
- **AI-driven natural-language scenario creation (§22)** — not built in this pass; the four scenario types are invoked directly with a structured `entityId`, not yet translated from a free-text question.
- **Real-action handoff (§29-30)** — not built, since this pass is read-only simulation only; wiring a simulation's output into an actual approval/execution flow would reuse the Evidence Graph SOW's existing Business Event/AI Action Request machinery rather than build a new one, when that need arises.
- **Business Workspace UI panel** — not built in this pass, matching the AWS S3 Feature Expansion SOW's own scoping decision to ship a complete, tested API surface first.

No claim of a "guaranteed prediction" is made anywhere in this work — every simulation result is explicit about what it computed from real data versus what remains unknown.
