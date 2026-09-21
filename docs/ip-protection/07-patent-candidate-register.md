# Patent Candidate Register

**Per the SOW: this is a candidate list only. No patent should be filed on the basis of this document alone, and nothing in this codebase's public materials should describe these mechanisms in patent-defeating detail until a qualified patent attorney has reviewed each candidate and a filing decision has been made.**

## Important jurisdictional caveat — read this before anything else in this document

Pakistan's Patents Ordinance, 2000 (Section 7) — like most Commonwealth-derived patent regimes — **excludes "a computer program" and "a scheme, rule or method for doing business" as such** from patentability. This does not mean *nothing* software-related can be patented in Pakistan; a genuinely novel **technical solution to a technical problem** that happens to be implemented in software can still qualify, but a claim that is really just "doing a known thing, but with a computer" or "a business process, automated" typically will not. Every candidate below needs to be evaluated against this specific line, by a patent attorney, before assuming it's patentable at all. This is the single most important filter for this whole SOW's Phase 6, and it's a real legal question, not a documentation task — it is explicitly not answered here.

## Candidates Worth Formal Evaluation

### 1. Permission-aware dependency-graph simulation with honest unknown-reporting and a verifiable non-mutation guarantee (Digital Twin / What-If Studio)

**What's arguably novel:** a business "what-if" simulation engine that (a) traverses a live dependency graph derived from existing production data without maintaining a separate graph database, (b) gates each node in the traversal by the querying user's actual permissions, disclosing restricted nodes as "exists but hidden" rather than either leaking them or silently omitting them, (c) refuses to report any consequence not directly backed by a real stored field (explicit `UNKNOWN` rather than an inferred/guessed value), and (d) produces a cryptographically verifiable, independently re-computable "proof this simulation never mutated real state" — tested by snapshotting every touched record before and after and asserting byte-for-byte equality.

**Why it's worth a real look:** the combination of permission-aware traversal + honest-unknown reporting + a cryptographic non-mutation proof, specifically for *business* (not purely technical/network) dependency graphs, is a more specific and less obviously prior-arted combination than any one piece alone. Graph traversal, permission checks, and audit logging are all individually well known; this particular combination applied to this problem is the actual candidate.

**Real prior-art risk:** simulation/what-if engines, permission-scoped queries, and audit logging all have deep individual prior art. The novelty claim would have to rest specifically on the combination and the non-mutation proof mechanism, not any one piece.

### 2. Duplicate-safe incremental cloud-to-decentralized-storage backup via an external diff layer that never modifies the underlying one-time-migration engine's own state model

**What's arguably novel:** rather than modifying a migration tool's own "already migrated" tracking (which is permanent-once-true, correct for one-time migration but wrong for a recurring backup), the recurring scheduler maintains its own independent, durable diff state (comparing real object size + content identifier, never trusting a timestamp alone) *outside* the migration engine, and satisfies that engine's existing interface with a disposable, per-run adapter — so the same, unmodified migration engine can serve both one-time migrations and recurring incremental backups without knowing the difference.

**Why it's worth a real look:** this is a genuine architectural technique for extending an existing tool's incremental-transfer capability without modifying its internals, which has some resemblance to caching/proxy-pattern prior art in general software engineering — but the specific application (reusing a one-time migration tool's verified transfer/retry logic for a recurring backup relationship, via an external diff+adapter layer) is more specific than generic proxy patterns.

**Real prior-art risk:** incremental backup / rsync-style diffing is extremely well-trodden prior art. The novelty claim, if any exists, is narrow — likely too narrow and too close to well-known incremental-backup techniques to be a strong candidate. Include for completeness; expect a patent attorney to screen this one out quickly.

### 3. Client-side sharding, dispersal, and multi-provider redundant storage with cryptographic proof-of-storage

**What's arguably novel:** the specific combination of client-side AES-256 encryption before sharding, binary dispersal across independent storage backends, and an on-chain proof-of-storage/backup-registry mechanism.

**Why it's flagged, but with a strong caution:** this is the area with the *densest* prior art and existing patent activity in the entire codebase — Filecoin, Storj, Sia, and multiple other decentralized storage networks have already published extensively (and in some cases filed patents) on sharding, dispersal, and proof-of-storage schemes. A real novelty search here needs to be thorough before any time is spent on this candidate; it is entirely possible the answer is "the concept is not patentable here, the specific implementation details are trade secrets instead" (see `06-confidentiality-trade-secret-framework.md`, Tier 1.1) — which may be the more realistic and cost-effective protection strategy for this particular asset.

### 4. Cross-chain bridge with M-of-N validator-signed messaging and unified multi-chain staking positions

**Why it's flagged, but with the same strong caution as #3:** cross-chain bridge architectures (validator sets, signed message relaying, lock-and-mint or burn-and-mint models) are one of the most heavily published and patent-active areas in blockchain infrastructure right now. Treat this the same way as #3 — a real prior-art search is essential before assuming there's anything left to claim.

## Recommendation

Based on the analysis above, **Candidate #1 is the strongest starting point** for a real, paid patentability assessment — it's the most specific, least crowded-by-prior-art candidate, and the one where the actual novel contribution (the specific combination, not any individual piece) is easiest to articulate to a patent attorney. Candidates #2–4 are included for completeness per the SOW's instruction to identify potentially novel inventions, but each carries either a narrow likely claim scope (#2) or dense, well-established prior art in its specific domain (#3, #4) that should be weighed against filing cost before proceeding.

**Do not file anything, and do not publicly disclose implementation-level detail about Candidate #1 specifically**, until a patent attorney has been consulted — public disclosure before filing can itself destroy novelty in many jurisdictions' patent systems, including likely Pakistan's.
