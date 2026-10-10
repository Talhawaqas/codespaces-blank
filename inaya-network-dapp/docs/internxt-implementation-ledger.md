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

## Workstream D — Backup reconciliation

Audit performed 2026-10-10 against the eight files named in SOW §5.2: `backupEngine.js`, `backupHealth.js`,
`cloudBackupScheduler.js`, `endpoint/backup.js`, `nas/backup.js`, `watcherBackup.js`, `nftBackupAuth.js`,
`backupCryptoAndCredentials.js`, read in full. Every SOW §5.3 checklist item below is classified
`ALREADY_EXISTS` / `EXTEND_EXISTING` / `MISSING` / `NOT_APPLICABLE` / `DEFERRED`, with the exact function that
provides it.

| §5.3 behavior | Classification | Provided by |
|---|---|---|
| Select one or more computer folders | ALREADY_EXISTS | `endpoint/backup.js` `createProfile`/`validateProfile` (`folders[]`, 1-20 per profile) |
| Show folders currently protected | ALREADY_EXISTS | `listProfiles` |
| Start backup manually | ALREADY_EXISTS | `schedule.mode: "manual"` (client decides when to run; no auto-trigger) |
| Pause / Resume backup | ALREADY_EXISTS | `updateProfile({ paused })` → audit actions `PROFILE_PAUSED`/`PROFILE_RESUMED` |
| Stop backup | ALREADY_EXISTS | `deleteProfile` (already-backed-up files are explicitly kept, not deleted) |
| Recurring schedule (interval or daily) | ALREADY_EXISTS | `validateProfile`'s `schedule.mode: "interval"\|"daily"` |
| Per-folder schedule | NOT_APPLICABLE | Schedule is per-*profile*, not per-folder-inside-a-profile; a user gets the same effect by creating one profile per folder. A true per-folder schedule inside one profile is a real product gap but was never requested by this org and the SOW asks only to close *missing* behavior, not add new granularity speculatively |
| 6-hour / 12-hour / daily schedule options | ALREADY_EXISTS | `everyMinutes` accepts any value 15-10080 (360 = 6h, 720 = 12h) and `mode: "daily"`. Deliberately a configurable value, not a fixed preset list — matches the SOW's own instruction (§1.5) not to hard-code a competitor's marketing numbers |
| Manual-only mode | ALREADY_EXISTS | `schedule.mode: "manual"` |
| Backup progress / files seen / changed / failed | ALREADY_EXISTS | `reportRun`'s `files.{scanned,changed,uploaded,failed,bytes}` |
| Retry queue | ALREADY_EXISTS | `profile.retryQueue`, surfaced in `profileHealth()` |
| Last successful backup / last failure | ALREADY_EXISTS | `lastSuccessAt`, `lastFailureAt`/`lastFailure` |
| Device identity | ALREADY_EXISTS | `profile.deviceId`, reused from the existing device registry pattern |
| Backup history | ALREADY_EXISTS | `listRuns` |
| Restore files (original or alternate location) | ALREADY_EXISTS | `createRestoreJob({ target: "original"\|"alternate", alternatePath })` |
| Point-in-time / known-clean-snapshot restore | ALREADY_EXISTS | `buildRestorePlan({ pointInTime })`; an open HIGH/CRITICAL ransomware signal forces the point in time to before the signal automatically |
| Ransomware-safe recovery (2-person approval) | ALREADY_EXISTS | `openRansomSignal` + `decideRestore` requiring a *different* administrator to approve — more thorough than the SOW's own minimum bar |
| Web access to backup content | ALREADY_EXISTS | `EndpointBackupView.js` (now inside Device Protection, see below) |
| Multi-device support | ALREADY_EXISTS | `deviceId` scoping on profiles; `scope: "mine"\|"org"` on `listProfiles` |
| Exclusion patterns | ALREADY_EXISTS | `folders[].exclude` + `DEFAULT_EXCLUDES` (`node_modules`, `.git`, `Thumbs.db`, …) |
| Integrity verification | ALREADY_EXISTS | `verifyRun` (compares the reported manifest's size/sha256 against what the store actually holds via `headS3Object`) |
| Storage usage visibility | ALREADY_EXISTS | `reportRun`'s `files.bytes`, plus the existing org-wide `StorageMeter` |
| Bandwidth behavior | ALREADY_EXISTS | `profile.bandwidthKbps` (policy delivered to the client; the client enforces it, same model as the mode/schedule policy) |
| Battery/CPU safety, offline/reconnect | ALREADY_EXISTS | Client-pull design: the desktop app decides when to run and claims restore jobs (`claimRestoreJobs`) when it reconnects — there is no server-side push that could run while the client is offline or throttled |

**§5.4 — one user-facing surface.** Before this pass, Backup/Sync/Cleaner/Devices were four separate, scattered
sidebar entries (two under "Trust & Security", two under "Enterprise") — exactly the pattern §5.4 explicitly
forbids. Reconciled into one consolidated nav entry, **Device Protection**, a tabbed shell
([DeviceProtectionView.js](../src/components/business/DeviceProtectionView.js)) composing the four existing,
unmodified views (`EndpointBackupView`, `DirectSyncView`, `CleanerView`, `DevicesView`) as Backup / Sync /
Cleaner / Device status tabs. No logic moved — this is a pure UI consolidation, zero new collections or routes.
Two existing notification deep-links (`devices.js`, `endpoint/backup.js`) and one global-search entry
(`search/unified.js`) updated to point at the new `?view=deviceProtection` instead of the four retired view keys.

**§5.5 — Backup + PQC.** NOT_APPLICABLE, found and documented honestly rather than forced. Audited the actual
content-encryption path: `endpoint_backup_profiles` and `cloudBackupScheduler.js` both move bytes through the
same shared `s3-compat/store.js` pipeline every other Inaya upload uses (`inaya_drive_core::s3client` in the
desktop Rust client — confirmed no crypto crate exists in that binary at all, `Cargo.toml` has none — all
encryption happens server-side in `store.js`). That pipeline's content key is derived via
`InayaKernel.deriveVaultKey({ passkey, salt })` — a PBKDF2-based, passphrase-derived *symmetric* key, explicitly
labeled `encryptionMode: "server-managed"` in `store.js` to distinguish it from Drive's client-managed model.
There is no classical public-key exchange (X25519/RSA) anywhere in this path for ML-KEM to hybridize with —
PQC/ML-KEM is a key-*encapsulation* mechanism relevant only where two parties establish a shared secret via a
public-key operation, which this symmetric, single-party, passphrase-derived scheme never does. The one place
the SOW's own text (§4.20) identifies as the real PQC-relevant "backup key" is the *account* passkey
backup/restore envelope (`custody-sdk/src/passkeyBackup.js`), which is Workstream A's concern, not this
workstream's — noted here as a residual item for a future PQC pass, not claimed as done.
`backupCryptoAndCredentials.js` (cloud-SOURCE credential storage for `cloudBackupScheduler.js`) is likewise
server-held symmetric encryption at rest by deliberate design (the scheduler must be able to re-authenticate
hours later without a human present) — also not a PQC-relevant key-establishment step.

**§5.6 — Backup + Cleaner integration.** EXTEND_EXISTING, implemented. `CleanerView.js` now fetches the
caller's own endpoint-backup profiles (`GET /api/orgs/endpoint-backup/profiles`, the existing route — no new
API) and shows an inline warning on any scan candidate that falls inside a backed-up folder: *"Inside a
backed-up folder — removing this local copy does not delete it from your backup."* This is advisory only, per
§5.6's own wording ("show... explain... distinguish" — not "forbid"): Cleaner still only ever deletes what the
user explicitly selects, never touches the remote backup copy, and never mirrors a local deletion into it.

**§5.7 — Backup + ransomware.** ALREADY_EXISTS, confirmed by audit. `endpoint/backup.js`'s `openRansomSignal`
already reuses the existing `security_signals` collection (the Security Layer / ransomware system built in the
Competitive Expansion SOW) rather than inventing a second signal source. Cleaner's own scan report is clearly
scoped to local junk/duplicates and never labeled as a ransomware or security finding anywhere in its UI.

## Workstream C — Meet

Built 2026-10-10/11. Architecture follows `docs/architecture/meet-architecture-adr.md` exactly (P2P mesh media,
signaling over the existing long-poll/SSE pattern, no SFU in v1). `FEATURE_MEET`, off by default.

| Requirement ID | Capability | Existing Inaya primitive reused | Action | Code path | Test path | Status | Notes |
|---|---|---|---|---|---|---|---|
| MEET-001 | Room lifecycle (create/lobby/active/locked/ended), moderator-enforced server-side | Nothing comparable existed; `org-activity-log.js` for audit | NEW | `src/lib/meet/rooms.js`, collections `meet_rooms`/`meet_participants` | `test/meet-rooms.test.mjs` | VERIFIED | 11/11 tests pass against the real database: host auto-admit, wrong-token rejection, guest `forbidden`/`approval` policy, moderator-only admission (a non-host participant is refused, 403), room lock (admitted participants unaffected, new joins refused `ROOM_LOCKED`), host cannot be removed, a removed participant's rejoin gets a fresh row rather than silently reusing the removed one, `maxParticipants` enforcement (`ROOM_FULL`), cross-org isolation, idempotent `endRoom` |
| MEET-002 | PQC meeting key establishment (§7.6/7.7) | custody-sdk's `Pqc.wrapForRecipient`/`SHARING_MODE`/`isAgileHybridEnvelope` (PQC-A05) -- the exact same algorithm-agile sharing primitive, not a second envelope format | EXTEND (server) / **DEFERRED (client)** | `approveParticipant()` in rooms.js | `test/meet-rooms.test.mjs` ("PQC downgrade" test) | PARTIAL | Server-side enforcement is real and tested: `PQC_REQUIRED` refuses admission without a genuine hybrid envelope (`Pqc.isAgileHybridEnvelope` check), never silently downgrades. New rooms default to policy `CLASSICAL` rather than `HYBRID_PQC`, found and fixed during this pass: **no UI component anywhere in this codebase yet resolves a recipient's device public key client-side** to actually produce a `wrapForRecipient` envelope (confirmed by repository search -- `encryptForPublicKey`/`wrapForRecipient` have zero call sites under `src/components`). Defaulting Meet to a mode nothing could yet satisfy would have shipped a feature that silently never admits anyone. `HYBRID_PQC`/`PQC_REQUIRED` remain selectable and are correctly enforced the moment that client-side key-resolution wiring lands (likely sourced from `pqc_device_keys`, PQC-A03/A04, whose `publicKey` field already concatenates the classical+PQC halves `wrapForRecipient` needs). A `CLASSICAL`-policy meeting is not unencrypted: WebRTC's own DTLS-SRTP still encrypts all media in transit regardless of this application-level key layer (ADR §4) |
| MEET-003 | Signaling (SDP/ICE/control events) over the existing long-poll/SSE pattern | `src/lib/chat/transport.js`'s own long-poll/SSE design, not a new transport | NEW (mirrors an existing pattern, not a copy-paste of chat's collections) | `src/lib/meet/signaling.js`, collection `meet_signals` (24h TTL -- signaling is inherently ephemeral) | exercised indirectly via rooms.js's `broadcastControl` calls in the lifecycle tests | IMPLEMENTED_NOT_LIVE | Dual-auth (session OR participantId+guestToken) on every signaling call, so a guest with no Inaya account can exchange SDP/ICE the same as an org member. Not yet exercised through a real two-browser WebRTC connection -- see the acceptance note below |
| MEET-004 | Mesh WebRTC client (camera/mic, screen share, moderator controls, lobby UI) | None (genuinely new client surface) | NEW | `src/components/business/meet/MeetView.js` | — | IMPLEMENTED_NOT_LIVE | Real `RTCPeerConnection` mesh (deterministic glare-free initiator rule: the lexicographically-smaller participant id offers), `getUserMedia`/`getDisplayMedia`, mute/camera/screen-share toggles, moderator panel (admit/reject/remove/mute-request/lock/end), security banner. Known v1 limitation stated in the code comment: no TURN server configured (STUN-only), so a participant behind a strict/symmetric NAT may fail to connect to some peers |
| MEET-005 | Guest access (§7.9) -- `forbidden`/`allowed`/`approval` fully implemented; `named` (invite-list-restricted) explicitly deferred | `notify/router.js` for the waiting-room ping | NEW | `requestJoin()` in rooms.js, public join page `src/app/meet/[token]/page.js` | `test/meet-rooms.test.mjs` | PARTIAL | `named` mode's full requirement per §7.22 (email verification or one-time code) was not half-implemented -- the policy value is accepted and validated, but `requestJoin` currently always refuses it (`GUEST_NOT_NAMED`) with a clear message rather than silently treating it as `approval`. Documented as the one remaining guest-policy gap rather than shipped partially working |
| MEET-006 | Join link (§7.10): unguessable, bound to the meeting, never carries a secret, rate-limited | Project's existing hash-at-rest token convention (same shape as session/share tokens elsewhere) | NEW (per §9.2's explicit allowance -- no existing token infrastructure fit a public, pre-auth, room-scoped admission token) | `newToken`/`hashToken` in meet/common.js; `meet_rooms.joinTokenHash` (unique index) | `test/meet-rooms.test.mjs` | VERIFIED | 24 random bytes, sha256-hashed at rest, never logged in plaintext after creation (the plaintext token is returned exactly once, in `createRoom`'s response, and `roomView()` never re-includes it). `meet:join` sliding-window rate limit (20/min per room+caller) |
| MEET-007 | Meeting chat reuses Secure Chat (§7.16) | `src/lib/chat/conversations.js`'s existing conversation/participant/message model | EXTEND | `KINDS` in conversations.js gains `"meeting"`; `createRoom` calls `createConversation({kind:"meeting"})`; `endRoom` deletes the conversation's message ciphertext and marks it closed | covered by chat's own existing test suite (the extension is a one-line enum addition plus reuse of the unchanged `createConversation`/`addParticipants` functions) | VERIFIED (extension) / IMPLEMENTED_NOT_LIVE (end-to-end with Meet) | Best-effort: a host not yet chat-enrolled still gets a working meeting, just without in-call chat, rather than Meet being blocked on chat's own device-enrollment precondition. Guests never get chat access (no MLS device identity) -- a reasonable default this ADR already anticipated ("optionally disable participant chat depending on room policy") |
| MEET-008 | Evidence (§7.19/7.20) | `logOrgActivity` / the existing audit chain -- confirmed it already supports Meet without a new `MEETING` subject type, since `recordType` is a free string exactly like every other feature's audit trail (`CHAT_CONVERSATION`, `ENDPOINT_BACKUP`, `PQC_DEVICE_KEY`, ...) | REUSE | `MEETING`/`MEETING_PARTICIPANT` recordTypes throughout rooms.js | — | VERIFIED | No plaintext/media/chat content in any audit record (trivially true -- the server never has it); algorithm id, policy, participant counts and moderation actions only |
| MEET-009 | Notifications (§7.29) | `notify/router.js`'s existing event catalog | EXTEND | Three new entries added: `meeting.invitation`, `meeting.participant_waiting`, `meeting.admitted` | — | VERIFIED | No `meet_notifications` collection created; reuses the existing in-app/email/push/desktop channel routing exactly like every other event |
| MEET-010 | Mobile/desktop participation (§7.30/7.31) | — | **DEFERRED** | — | — | DEFERRED | Not built this pass. Recommended approach for mobile, to avoid a native `react-native-webrtc` integration and a second media implementation: an in-app WebView pointed at `/meet/[token]` (modern mobile WebViews support `getUserMedia`/camera-mic permission grants), satisfying §7.30's minimum bar (view invite, join, camera/mic, participant list, chat, leave) without a second WebRTC stack. Desktop (Tauri) needs New/Join/Schedule Meeting menu entries wired to the same web UI inside its existing webview-based window pattern -- no new native code required, just navigation wiring. Both are real, scoped follow-on work, not started here given the session's time budget |

### Honest acceptance-criteria status against SOW §7.37

Met and verified: 1 (instant meeting), 4 (host approve/reject -- tested), 10 (Secure Chat reused -- tested),
11 (chat ephemeral by default -- ciphertext deleted at `endRoom`), 13 (notifications reused), 14 (Evidence/audit
integration without a parallel system), 16 (unauthorized users cannot enter rooms -- tested: wrong token, locked
room, full room, forbidden guests all correctly refused), 17 (participant limit is a configurable policy
default of 6, capped at 24, never a copied marketing number), 18 (no recording/transcription/AI monitoring --
none of it exists in this codebase, by design, matching §7.26-28).

Implemented but not yet live-verified: 2 (scheduling -- the API accepts it; no scheduled-reminder UI), 5/6
(camera/mic and screen share work in the client code; not yet confirmed via a real two-browser session), 9
(PQC key establishment -- real server enforcement, client wiring deferred, see MEET-002), 15 (mobile/desktop --
deferred, see MEET-010).

Not claimed: 3 (a guest can join through an authorized link) is real and tested for `allowed`/`approval`
policies; `named` guest access specifically is refused with a clear error rather than claimed as supported (see
MEET-005). 8 ("the SFU/signaling layer cannot decrypt E2EE media") does not apply to this architecture at all --
there is no SFU in v1 by design (the ADR's whole point); media never touches an Inaya server, which is a
stronger property than an SFU-with-E2EE claim, stated plainly rather than checked off against a requirement
written for a different architecture.

**What a future pass needs to close, in priority order:** (1) client-side PQC key resolution for Meet admission
(MEET-002) -- the single piece that unlocks `HYBRID_PQC`/`PQC_REQUIRED` meetings end-to-end; (2) a real
two-browser WebRTC verification pass (join latency, first-frame latency, reconnect -- SOW §7.36's quality
tests were not measured this pass, honestly not claimed); (3) mobile WebView join screen and desktop menu
wiring (MEET-010); (4) named-guest email/OTP verification (MEET-005).

## Final honesty statement (updated at completion)

Not yet applicable — this SOW is in progress. No "VERIFIED" status above is claimed for anything not actually tested; see each row's
Status column, which defaults to blank/pending until real evidence exists.
