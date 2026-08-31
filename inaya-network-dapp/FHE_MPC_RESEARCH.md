# Confidential Multi-Party Computation (FHE/MPC) — Research

Long-Term R&D deliverable per the Business Workspace hardening SOW. This is a research and feasibility document, not an implementation plan — no code ships from this doc. Grounded in Inaya's actual current architecture (verified against the codebase, not assumed).

## 1. What's actually encrypted today, and what isn't

This matters more than any cryptography survey, because it determines what problem FHE/MPC would even be solving:

- **Documents** (Business Workspace file uploads) are genuinely end-to-end encrypted client-side: `src/lib/clientCrypto.js` derives an AES-256-GCM key via PBKDF2 (100,000 iterations) from a user-supplied passkey, encrypts the file, splits the ciphertext at its midpoint, and pins both halves to IPFS via Pinata under two element tags ("Alpha"/"Beta"). The server (and Pinata) never sees plaintext file content or the passkey. This is the strongest confidentiality guarantee anywhere in the stack.
- **Structured business data is NOT encrypted at rest.** Invoices, expenses, tasks, CRM contacts/deals, employee records, and every KPI/Insights figure live as plaintext documents in MongoDB, scoped by `orgId`. `getAccessibleScope()` (`document-permissions.js`) resolves what a given member can see, but that's an *authorization* boundary enforced by application code — the database itself, and anyone with direct DB access (Inaya operators, a compromised backend), can read every org's plaintext financial and HR data today.
- **Insights/KPIs are computed server-side over that plaintext** (`business-insights.js`'s `computeBusinessInsights()`) — sums, period-over-period comparisons, trend series. The server sees real numbers to produce these.

So "computing aggregate Insights KPIs without the server ever seeing plaintext" (the SOW's framing) is really two different problems depending on which data:

1. Protecting **structured financial/HR data** (invoices, expenses, employee records) from the server itself — a genuine confidentiality upgrade over the current model.
2. Protecting **document contents** — already solved by client-side AES-GCM; FHE/MPC add nothing here that isn't already achieved.

This doc focuses on (1), since (2) is a solved problem.

## 2. What FHE would actually buy here

Fully Homomorphic Encryption lets a party compute on ciphertexts and get a result that decrypts to the correct answer, without ever seeing plaintext. Applied to Inaya: a client encrypts its invoice/expense amounts with an FHE scheme, the server sums the ciphertexts (homomorphic addition) to compute e.g. `totalOutstanding`, and only the client (or an authorized viewer holding the decryption key) can decrypt the result.

**Where this fits Inaya's actual computations**: `computeBusinessInsights()`'s heaviest operations are sums, counts, and simple ratios (revenue, expense totals, win rate, task completion rate) — these map cleanly onto FHE's cheapest operation, homomorphic addition, under schemes like BFV or BGV (integer arithmetic) or CKKS (approximate real-number arithmetic, better suited to currency-like values with rounding tolerance). Comparisons and period-over-period deltas (used for the "▲/▼ X%" trend indicators) are more expensive under FHE — comparison and division aren't native FHE operations and require costly circuit constructions or approximations.

**Practical library landscape** (as of this research pass):
- **Microsoft SEAL** (`node-seal` — a WASM binding) — mature, general-purpose FHE (BFV/CKKS), usable from Node.js. The most realistic option if a pilot were built, since it doesn't require standing up a separate service in another language.
- **Zama's `concrete`/`TFHE-rs`** — Rust-native, boolean/integer FHE with fast bootstrapping; strong for exact comparisons but heavier tooling, no first-class Node bindings as clean as SEAL's.
- **Zama's `fhEVM`** — an on-chain confidential smart-contract framework (FHE computation inside an EVM-compatible chain). This would mean moving Insights computation on-chain, a fundamentally different architecture than "aggregate over MongoDB documents" — not a fit for what Inaya's Insights dashboard actually does today.

**Honest cost assessment**: even homomorphic addition under SEAL carries real overhead — ciphertexts are orders of magnitude larger than plaintext integers (kilobytes per encrypted value vs. 8 bytes), and every `computeBusinessInsights()` call today does dozens of aggregate operations across multiple collections per request, live, on every dashboard load. Encrypting and homomorphically summing at that call frequency would be a meaningful latency and storage regression, not a drop-in swap.

## 3. What MPC would actually buy here

Secure Multi-Party Computation lets several parties jointly compute a function over their private inputs without revealing those inputs to each other. Within a *single* org's own data, MPC doesn't add much over FHE or over trusting the server less — there's only one data owner (the org). MPC's real value shows up in the **cross-tenant** case (see the companion doc, `CROSS_TENANT_ANALYTICS_RESEARCH.md`), where multiple orgs' private data needs to be aggregated without any one party (including Inaya) learning another org's individual figures.

## 4. Feasibility verdict

**Not practical to build now, and not clearly worth building even later, for the specific case the SOW names** (server-blind Insights KPIs within one org): Inaya's own backend already has full plaintext access to every org's structured business data by design — there is no cryptographic boundary between "the org's data" and "what Inaya's backend can see" anywhere except Documents. Adding FHE for Insights-only computation would protect against a threat (a compromised or malicious Inaya backend) that the rest of the architecture doesn't currently defend against either — it would be security theater unless paired with a much larger architectural shift (client-side encryption of ALL structured business data, not just documents), which is out of scope for anything resembling the current product.

**Where FHE genuinely earns its cost**: a narrow, specific use case — e.g. a future enterprise-tier customer who explicitly does not want Inaya's backend to ever see raw invoice amounts, only aggregate totals they authorize computing. That's a real, sellable confidentiality feature, not a general-purpose upgrade to the existing dashboard.

## 5. Recommended next step (if this is ever prioritized)

1. **Don't build FHE for Insights broadly.** The cost/benefit doesn't clear given the current trust model.
2. **If a genuine "server-blind aggregate" requirement emerges** (e.g. a compliance-driven enterprise customer), pilot a narrow proof of concept: encrypt only `expenses.amount` (a single scalar field, already isolated per-org) with `node-seal`'s CKKS scheme, homomorphically sum it server-side to reproduce `list_expenses`' existing `totalAmount` field, and benchmark real latency/storage cost against the current plaintext path before deciding whether to expand scope.
3. **Track Zama's fhEVM maturity** separately, since Inaya already has an on-chain settlement pattern (`InayaNodeRegistry.sol`'s 36h delay, reused by Guarded Execution's `ai-action-requests.js`) — if a future feature genuinely needs on-chain confidential computation, fhEVM is the more natural fit than retrofitting FHE into the existing MongoDB-based aggregation path.
