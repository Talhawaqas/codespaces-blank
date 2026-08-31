# Privacy-Preserving Cross-Tenant Analytics — Research

Long-Term R&D deliverable per the Business Workspace hardening SOW. Research and feasibility document only — no code ships from this doc. Companion to `FHE_MPC_RESEARCH.md`; read that doc's §1 first for what is and isn't encrypted today, since it changes which approaches are actually meaningful here.

## 1. The isolation boundary this has to respect

`orgId` scoping is foundational throughout the codebase, not a convention layered on top:

- Every Business Operations collection (`invoices`, `expenses`, `tasks`, `crm_contacts`, `employees`, etc. — see `orgs.js`'s `getOrgCollections()`) carries `orgId` as a first-class field.
- `getAccessibleScope()` (`document-permissions.js`) resolves visibility per-request from the caller's real membership — there is no code path today that reads across multiple orgs' data in one query.
- `requireMembership()` (`orgs.js`) is the universal auth gate on every org-scoped API route; a member of Org A has no membership record for Org B and is rejected outright, not merely filtered.

Any cross-tenant analytics feature — e.g. "average invoice value across all Inaya business customers," a benchmarking figure worth putting on a sales page or an internal ops dashboard — has to be built as a deliberate, narrow exception to this boundary, never a byproduct of a query that "just happens" to span orgs.

## 2. The key fact that simplifies this: Inaya's backend already sees every org's plaintext structured data

Per the companion doc's §1: invoices, expenses, tasks, CRM, and HR records are **not** client-side encrypted — only Documents are. That means Inaya's own backend (not any individual org) is the one party that already has the plaintext needed to compute a real cross-org aggregate. The privacy problem here is narrower than the general MPC literature's "N mutually-distrusting parties, none of whom trust a central server" — it's "how does Inaya publish an aggregate statistic without that statistic (or a series of queries against it) letting someone reverse-engineer any single org's real figures."

That reframing rules out needing full MPC for a near-term version of this feature and points at **differential privacy (DP)** as the practical fit.

## 3. Differential Privacy — the recommended near-term approach

**Mechanism**: for a query like `AVG(invoice.total)` across all orgs, compute the real aggregate server-side (which the backend can already do — nothing new here), then add calibrated random noise (typically Laplace or Gaussian) before returning it. The noise magnitude is tuned by a privacy budget (ε — epsilon): smaller ε means more noise, stronger guarantee that no single org's contribution is detectable, but a less precise published number. Composability matters — every query against the same underlying data spends more of a tracked privacy budget, so a rate-limited, budget-tracked query surface (not an open-ended API) is the actual design requirement, not just "add noise once."

**Concretely, for Inaya**: a small number of well-defined aggregate queries (average invoice value, expense-category distribution, task-completion-rate benchmarks) computed on a schedule (e.g. nightly, mirroring the existing cron pattern — `invoices-mark-overdue`, `execute-approved-ai-actions`), with noise added before the result is cached/published, and a hard cap on how many distinct queries can be run against the same underlying dataset before the privacy budget for that period is exhausted.

**Why this fits the codebase's own conventions**: this project consistently hand-rolls small, well-scoped utilities over pulling in heavy dependencies (the CSV export builder, the client-side crypto pipeline, the hash-chained audit trail). A Laplace-mechanism DP function for a handful of specific aggregate types (sum, count, average) is genuinely simple to hand-roll correctly — it's a few dozen lines of noise-sampling code, not a framework. A library like Google's `differential-privacy` (has a C++ core with bindings, not a natural Node fit) is more machinery than this specific need justifies; OpenDP's Rust core has better modularity but again no first-class Node story. Hand-rolling the Laplace mechanism for the specific, small set of aggregate functions Inaya would actually expose is the pragmatic choice, consistent with how this codebase already treats similarly-scoped cryptographic/statistical utilities.

**What this does NOT require**: no new cryptographic protocol, no change to how structured data is stored (still plaintext MongoDB, still `orgId`-scoped for every existing query path), no client-side changes. This is purely a new, narrow, rate-limited read path with a noise layer — additive, same as the audit chain and guarded execution were additive layers over existing logging/workflow functions.

## 4. Where genuine secure aggregation / MPC would be needed instead

MPC (or an alternative like a trusted execution environment) becomes necessary only if the trust model changes to **exclude Inaya's own backend** from seeing plaintext structured data — i.e., if a future requirement says even Inaya operators must not be able to read individual orgs' invoice/expense figures, only jointly-computed aggregates. That would require:

- Client-side encryption expanded from Documents-only to structured business records too (a major architecture change, not a small feature).
- A genuine secret-sharing-based secure-sum protocol (e.g. patterns from MP-SPDZ or a lighter custom additive secret-sharing scheme for simple sums) run across org-held shares, or a per-org enclave/TEE approach.
- Meaningfully more operational complexity: key management per org, a coordination protocol for the aggregation round, and failure handling when an org's shard is unavailable.

This is a real, defensible design if Inaya's product positioning ever shifts toward "we cannot see your data, only computed aggregates you opt into" as a first-class guarantee (the kind of claim that would show up in a security page or an enterprise sales conversation). It is not justified by the current architecture, where the backend already holds plaintext for every other purpose (permission resolution, workflow transitions, the Insights dashboard itself).

## 5. Recommendation

1. **Build differential privacy, not MPC, if/when cross-tenant analytics is prioritized.** It matches the actual current trust model, requires no architecture change, and is buildable as a small, well-scoped addition following this codebase's existing conventions (hand-rolled utility, cron-driven computation, rate-limited/budget-tracked query surface).
2. **Scope the first version narrowly**: 2-3 specific aggregate queries (e.g. average invoice value, task completion rate benchmark), not an open query interface — matches the SOW's own "no unnecessary token/reward mechanics"-style discipline toward not over-building speculative surface area.
3. **Revisit MPC/enclave approaches only if Inaya's trust model is explicitly redefined** to exclude the backend itself from seeing org data — track this as a dependency on a product/positioning decision, not a purely technical one.
