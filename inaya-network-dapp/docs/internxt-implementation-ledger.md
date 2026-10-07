# Internxt-inspired expansion — implementation ledger

Living document, updated as each workstream progresses. One row per requirement. `Action`: REUSE / EXTEND / NEW / DEFERRED.
`Status`: per SOW §23 — `VERIFIED` / `IMPLEMENTED_NOT_LIVE` / `PARTIAL` / `CONFIGURED` / `NOT_CONFIGURED` / `UNSUPPORTED` / `DEFERRED` / `FUTURE`.

## Phase 0 — Audit and documentation

| Requirement ID | Capability | Source behavior | Existing Inaya primitive | Action | Code path | Status | Notes |
|---|---|---|---|---|---|---|---|
| P0-001 | Gap analysis | SOW §3.1.4 | — | NEW | `docs/internxt-gap-analysis.md` | VERIFIED | Written this session |
| P0-002 | Feature reuse matrix | SOW §3.1.5 | — | NEW | `docs/internxt-feature-reuse-matrix.md` | VERIFIED | Written this session |
| P0-003 | PQC ADR | SOW §3.1.6 | — | NEW | `docs/architecture/pqc-architecture-adr.md` | VERIFIED | Written this session |
| P0-004 | Meet ADR | SOW §3.1.7 | — | NEW | `docs/architecture/meet-architecture-adr.md` | VERIFIED | Written this session |
| P0-005 | Cleaner ADR | SOW §3.1.8 | — | NEW | `docs/architecture/cleaner-safety-adr.md` | VERIFIED | Written this session |
| P0-006 | PQC threat model | SOW §13 | — | NEW | `docs/security/pqc-threat-model.md` | VERIFIED | Written this session |
| P0-007 | Meet threat model | SOW §13 | — | NEW | `docs/security/meet-threat-model.md` | VERIFIED | Written this session |
| P0-008 | Cleaner threat model | SOW §13 | — | NEW | `docs/security/cleaner-threat-model.md` | VERIFIED | Written this session |

## Workstream A — PQC layer

| Requirement ID | Capability | Existing Inaya primitive reused | Action | Code path | Test path | Status | Notes |
|---|---|---|---|---|---|---|---|
| PQC-A01 | Algorithm-agile PQC provider abstraction | `@noble/*` crypto family already in `custody-sdk/src/crypto.js` | NEW | `custody-sdk/src/pqc/provider.js` | `custody-sdk/test/pqc.test.mjs` | VERIFIED | Backed by `@noble/post-quantum`'s `KitchenSink_ml_kem768_x25519` hybrid preset (library-maintained combiner, not hand-rolled). 17/17 new tests pass; full `custody-sdk` suite 117/117, zero regressions |
| PQC-A02 | Versioned hybrid envelope + domain-separated HKDF | `@noble/ciphers` AES-GCM already in `crypto.js` | NEW | `custody-sdk/src/pqc/envelope.js` | `custody-sdk/test/pqc.test.mjs` | VERIFIED | Wraps/unwraps a content key only, never file bytes; AAD-bound AES-256-GCM over the hybrid shared secret. Adversarial tests pass: wrong recipient, tampered AAD, tampered ciphertext, unknown algorithm, unknown version all rejected with `InayaDecryptionError`/`InayaValidationError`, never a silent wrong result |
| PQC-A02b | SDK public surface | `InayaKernel` namespace pattern (`Backup`, `Shares`, etc.) | NEW | `custody-sdk/src/pqc.js`, wired into `custody-sdk/src/index.js` as `InayaKernel.Pqc` | `custody-sdk/test/pqc.test.mjs` | VERIFIED | `Pqc.generateDeviceKeyPair/wrapContentKeyHybrid/unwrapContentKeyHybrid/capabilityInfo/isHybridEnvelope` — confirmed loadable through the real package entry point |
| PQC-A03 | Device PQC key registry | Device revocation workflow (Competitive Expansion) | NEW | `src/lib/pqc/deviceKeys.js`, collection `pqc_device_keys` | — | — | Pending — next |
| PQC-A04 | PQC device key API (register/rotate/revoke) | `requireMembership()` route pattern | NEW route, REUSE auth | `src/app/api/orgs/pqc/devices/**` | — | — | Pending |
| PQC-A05 | Algorithm-agile sharing envelope | `src/lib/chat/conversations.js` existing X25519/XChaCha envelope | EXTEND | `src/lib/chat/conversations.js` | — | — | Pending |

### Cross-platform interop note (PQC-010)

`@noble/post-quantum` is pure JS/TS with no WASM/native backend, so web, Node (API routes), React Native (mobile), and Tauri webviews
(desktop) all run the identical implementation — unlike `ts-mls` (chat), which needed a platform-specific crypto provider split. The
interop test above simulates this directly (two independently-generated key pairs, one wraps to the other). Real device-to-device
interop across actual web/mobile/desktop builds is still pending until PQC-A03/A04 land and a real multi-client test can run.

## Workstream B — Cleaner

(rows added as implementation proceeds)

## Workstream C — Meet

(rows added as implementation proceeds)

## Workstream D — Backup reconciliation

(rows added once the formal per-file audit against SOW §5.3 runs)

## Final honesty statement (updated at completion)

Not yet applicable — this SOW is in progress. No "VERIFIED" status above is claimed for anything not actually tested; see each row's
Status column, which defaults to blank/pending until real evidence exists.
