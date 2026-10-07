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
| PQC-A01 | Algorithm-agile PQC provider abstraction | `@noble/*` crypto family already in `custody-sdk/src/crypto.js` | NEW | `custody-sdk/src/pqc/provider.js` | `custody-sdk/test/pqc.test.mjs` | VERIFIED | **Revised 2026-10-07**: the original implementation used `@noble/post-quantum`'s bundled `KitchenSink_ml_kem768_x25519` combiner. The dApp's own `npm run build` caught a real runtime failure (`"curve" expected object, got type=undefined`) in an unrelated AI-wallet route once that combiner's hard `@noble/curves` 2.x dependency collided with the rest of the app's pinned 1.9.7 in one webpack bundle. Rewritten to combine `ml_kem768` (hashes-only, no curves dependency) with this SDK's own existing `x25519` import through a domain-separated HKDF-SHA256 -- the SOW's own §4.12-anticipated fallback, never a bare `SHA256(a+b)`. Verified against the dApp's actual resolved dependency tree, not just custody-sdk's isolated one. Full `custody-sdk` suite: 127/127, zero regressions |
| PQC-A02 | Versioned hybrid envelope + domain-separated HKDF | `@noble/ciphers` AES-GCM already in `crypto.js` | NEW | `custody-sdk/src/pqc/envelope.js` | `custody-sdk/test/pqc.test.mjs` | VERIFIED | Wraps/unwraps a content key only, never file bytes; AAD-bound AES-256-GCM over the hybrid shared secret. Adversarial tests pass: wrong recipient, tampered AAD, tampered ciphertext, unknown algorithm, unknown version all rejected with `InayaDecryptionError`/`InayaValidationError`, never a silent wrong result |
| PQC-A02b | SDK public surface | `InayaKernel` namespace pattern (`Backup`, `Shares`, etc.) | NEW | `custody-sdk/src/pqc.js`, wired into `custody-sdk/src/index.js` as `InayaKernel.Pqc` | `custody-sdk/test/pqc.test.mjs` | VERIFIED | `Pqc.generateDeviceKeyPair/wrapContentKeyHybrid/unwrapContentKeyHybrid/capabilityInfo/isHybridEnvelope` — confirmed loadable through the real package entry point |
| PQC-A03 | Device PQC key registry | Device identity reused from `org_devices` (Competitive Expansion); audit reused from `logOrgActivity` | NEW | `src/lib/pqc/deviceKeys.js`, collection `pqc_device_keys` | `test/pqc-device-keys.test.mjs` | VERIFIED | A PQC key must reference an already-checked-in `org_devices` record; cannot register for someone else's device; blocked/revoked devices rejected. 13/13 tests pass against the real database |
| PQC-A04 | PQC device key API (register/list/resolve-active/revoke) | `requireMembership()` route pattern (same as `../devices/_lib.js`) | NEW route, REUSE auth | `src/app/api/orgs/pqc/devices/{route.js,[deviceId]/active-key/route.js,[deviceId]/[keyId]/revoke/route.js}` | covered via `src/lib/pqc/deviceKeys.js` unit tests (route layer is a thin wrapper, same pattern as `devices/_lib.js`) | IMPLEMENTED_NOT_LIVE | Gated behind new `FEATURE_PQC` flag (off by default). **A real bug was caught by `npm run build`**: the two nested dynamic routes (`[deviceId]/[keyId]/revoke`, `[deviceId]/active-key`) had an off-by-one error in their relative import path to `deviceKeys.js`, computed by hand instead of verified -- fixed by computing every import path in the route group with `realpath --relative-to` instead of counting directory levels manually, confirmed by a second clean build. Not yet exercised via a real HTTP round trip or in a browser |
| PQC-A05 | Algorithm-agile sharing envelope | `custody-sdk/src/crypto.js`'s `encryptForPublicKey`/`decryptWithSecretKey` (the real X25519/XChaCha "sealed box" sharing primitive, in production use for passkey-sharing today) | EXTEND | `custody-sdk/src/pqc/agileSharing.js` | `custody-sdk/test/pqc-agile-sharing.test.mjs` | VERIFIED | **Plan correction**: the approved plan named `src/lib/chat/conversations.js` as this requirement's target; that file implements MLS (chat's own protocol, untouched, correctly out of scope here) and has no X25519/XChaCha sharing code at all. The actual sharing primitive lives in `custody-sdk/src/crypto.js` and is called directly from client code, not wrapped by a chat-lib file. Corrected during implementation; `encryptForPublicKey`/`decryptWithSecretKey` are called unchanged for `LEGACY_CLASSICAL`, never forked. 10/10 new tests pass: classical-path byte-identical reuse, hybrid selection when a PQC key exists, honest fallback for `HYBRID_PQC` with no key on file, and `PQC_REQUIRED` refusing to downgrade (adversarial test). Full `custody-sdk` suite: 127/127, zero regressions |

### Cross-platform interop note (PQC-010)

`@noble/post-quantum` is pure JS/TS with no WASM/native backend, so web, Node (API routes), React Native (mobile), and Tauri webviews
(desktop) all run the identical implementation — unlike `ts-mls` (chat), which needed a platform-specific crypto provider split. The
interop test above simulates this directly (two independently-generated key pairs, one wraps to the other). Real device-to-device
interop across actual web/mobile/desktop builds is still pending until PQC-A03/A04 land and a real multi-client test can run.

## Workstream B — Cleaner

| Requirement ID | Capability | Existing Inaya primitive reused | Action | Code path | Test path | Status | Notes |
|---|---|---|---|---|---|---|---|
| CLN-001 | Local-only temp-file scan | `walkdir`/`sha2`/`hex` crates already in `Cargo.toml` for DirectSync's hashing; Tauri `build.rs`/`capabilities` command pattern already established | NEW | `inaya-desktop/src-tauri/src/cleaner.rs` (`scan_temporary_files`, `default_temp_directories`) | `cleaner.rs` `#[cfg(test)]` module | VERIFIED | Real filesystem tests, not mocked. Symlinks not followed (walkdir's own default) |
| CLN-002 | Duplicate detection (content-equality, size-first staging) | same | NEW | `cleaner.rs` (`scan_duplicates`) | same | VERIFIED | Confirmed same-size-different-content is never falsely grouped; a real content hash is required |
| CLN-003 | Protected paths enforced at the final deletion primitive, not just scan time | Reuses the existing DirectSync SQLite state file path and app-data dir as additional protected entries | NEW | `cleaner.rs` (`protected_paths`, `is_protected`, re-checked inside `cleanup_selected`) | same | VERIFIED | Adversarial test: a protected file passed directly to cleanup (simulating a bypassed review screen) is refused and confirmed still on disk afterward |
| CLN-004/005 | User reviews candidates before cleanup; explicit confirmation | `EmptyState` component convention (`DirectSyncView.js`) | NEW | `src/components/business/CleanerView.js` | — | IMPLEMENTED_NOT_LIVE | Built following `DirectSyncView.js`'s exact `window.__TAURI__.core.invoke()` pattern; a real field-name casing bug (Tauri return values are NOT auto-camelCased, confirmed from DirectSync's own `folder.local_path` usage) was caught and fixed before any live test, not after |
| CLN-006 | Correct reclaimed-space total | same | NEW | `cleaner.rs` (`cleanup_selected`) | same | VERIFIED | A real file's exact byte size is asserted in the trash-move test |
| CLN-007 | No unsafe shell execution | Direct `std::fs`/`walkdir`/`trash` crate calls only, no shell string ever constructed | NEW | `cleaner.rs` | code review | VERIFIED | No `Command::new("rm"/"del")` or shell interpolation anywhere in the module |
| CLN-008/009/010 | Platform verification | — | NEW | `cleaner.rs` | real `cargo test` run | PARTIAL | This session's `cargo test` and `cargo build --release` ran on real Windows (this machine) -- Windows is the one platform actually exercised so far. Linux is written against the same cross-platform `trash`/`walkdir` crates already proven on Linux elsewhere in this codebase (Inaya Drive) but not yet run on a real Linux machine. macOS untested, no hardware available, honestly not claimed |

Desktop commands (`cleaner_scan`, `cleaner_cleanup`) are wired through the standard
`build.rs` COMMANDS manifest + `capabilities/default.json` `allow-*` grants + `verify_trusted_origin`
pattern, identical to every existing command. `cargo build --release` compiles cleanly (one
pre-existing, unrelated warning only). A real launch of the compiled `inaya-desktop.exe` with
WebView2 remote debugging was attempted to call `cleaner_scan` through the live Rust↔JS bridge:
the app launched and loaded the real production page, and a CDP WebSocket connection to it opened
successfully, but the CDP command/response round trip did not complete in this environment (likely
a local tooling/networking limitation, not a code defect — the connection itself worked). Stated
honestly rather than claimed: the Rust-level logic is real and tested (9 filesystem tests above);
the actual live Tauri command round trip and the React UI click-through are not yet verified live
and remain the next step.

## Workstream C — Meet

(rows added as implementation proceeds)

## Workstream D — Backup reconciliation

(rows added once the formal per-file audit against SOW §5.3 runs)

## Final honesty statement (updated at completion)

Not yet applicable — this SOW is in progress. No "VERIFIED" status above is claimed for anything not actually tested; see each row's
Status column, which defaults to blank/pending until real evidence exists.
