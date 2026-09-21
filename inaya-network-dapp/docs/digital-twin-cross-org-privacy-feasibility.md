# Cross-Organization Digital Twin Privacy Feasibility

**SOW section covered:** Phase 10, §38-44 (Cross-Organization Digital Twins, privacy mechanism evaluation).
**Recommendation: DEFER.**

## What was asked

Two organizations, each with their own private Twin, exchange a narrow query — e.g. "can Company B fulfil a 10,000-unit order next month?" — without Company A ever seeing Company B's inventory, suppliers, customers, or internal records.

## Why this is evaluated but not built in this pass

1. **No validated business need today.** Nothing in this codebase or this session's work has a real, waiting cross-org query use case — no customer has asked for it, no existing feature half-implements it. Building real cross-org privacy infrastructure speculatively is exactly what the SOW's own §39 warns against: "do not implement heavyweight cryptography merely for branding."
2. **The single-org Digital Twin this SOW delivers has to exist and be trustworthy first.** A cross-org query is only as honest as the Twin answering it — this pass's single-org dependency graph and scenario engine (`digitalTwin.js`/`digitalTwinSimulate.js`) is the necessary foundation; a cross-org layer on top of an unproven foundation would be premature.
3. **Every real option carries genuine cost/complexity that needs a committed use case to justify.**

## Options evaluated

| Approach | Security | Correctness | Performance | Cost | Complexity | Verdict |
|---|---|---|---|---|---|---|
| **Zero-knowledge proofs** (e.g., a ZK circuit proving "capacity ≥ N" without revealing capacity) | Strong — provably reveals nothing beyond the boolean claim | Strong, if circuit is correctly specified | Proof generation is real CPU/latency cost, non-trivial for a capacity computation over live inventory data | High — circuit design, audited libraries, ongoing proving infrastructure | High — this repo has no existing ZK tooling anywhere (confirmed: no ZK dependency in package.json) | Best long-term fit if a real committed use case emerges, but too heavy to start speculatively |
| **Secure multiparty computation (MPC)** | Strong for the specific joint computation defined | Strong | Requires both parties online simultaneously, real network-round-trip cost | High — no existing MPC infrastructure in this codebase or its dependencies | High | Same verdict as ZK — heavy, no existing foundation |
| **Trusted execution environment (TEE)** | Depends on trusting the enclave provider/hardware — a different trust model than Inaya's own client-side-encryption philosophy elsewhere in this codebase | Good if the enclave is correctly attested | Better performance than ZK/MPC | Requires specific cloud/hardware support Inaya doesn't currently provision | Medium | Philosophically inconsistent with the rest of this codebase's "don't trust a third party, prove it cryptographically" stance — not recommended even later |
| **Cryptographic commitments + selective disclosure** (commit to full inventory, reveal only a range proof) | Moderate — leakage depends on how tight the range proof is | Moderate | Cheaper than full ZK | Moderate | Moderate | A reasonable middle ground if a real use case appears — still not zero-build |
| **Scoped, purpose-bound API with response bucketing** (no cryptographic zero-knowledge property; Company B's own server computes and returns only a coarse "yes/no" or bucketed answer, under an explicit, revocable, audited trust relationship) | Weaker than a cryptographic proof — Company B's server itself must be trusted to answer honestly and not over-disclose; this is the SAME trust model Inaya already uses for every other org-to-org feature in this codebase | Simple, easy to get right | Cheap | Low — reuses `orgTrustRelationships` (already a real collection in `orgs.js`) and the existing audit chain | Low | **Recommended if/when a real use case appears** — not built now, but the cheapest genuine option, and the one this codebase is already structurally closest to supporting |

## Leakage analysis (applies to any option eventually chosen)

Per the SOW's own §43, repeated queries against even a perfectly "zero-knowledge" boolean answer leak a binary-search-able capacity boundary over enough queries (ask for 10,000 → yes; 15,000 → no; binary search narrows the true value). Any real implementation — cryptographic or not — needs:
- Purpose binding (the query states what it's for; an unrelated second query on the same relationship is suspicious)
- Rate limiting per trust relationship
- Coarse response buckets rather than exact answers, where the use case tolerates it

None of this is specific to the cryptographic mechanism chosen — it's a query-design requirement layered on top of whichever mechanism is picked.

## What already exists to build on, when this is picked back up

- `orgTrustRelationships` (see `orgs.js`) — an existing collection for explicit, scoped trust between two orgs, from an earlier SOW. Not currently used for data queries, but the right foundation for "purpose-bound, revocable, audited" cross-org trust this feature would need.
- The audit chain (`auditChain.js`) — both sides of a cross-org exchange could log their own query/response into their own existing chain, giving each org an independently verifiable record of what was asked/answered, without a third system.

## Recommendation

**Defer.** Revisit only when a real, named business need for cross-org querying exists. At that point, start with the "scoped, purpose-bound API" row above — it is the cheapest option, reuses real existing infrastructure (`orgTrustRelationships`, the audit chain), and can be upgraded to a cryptographic mechanism later if the trust-the-responding-org's-server model proves insufficient for a specific customer's requirements. Do not build ZK/MPC/TEE infrastructure speculatively.
