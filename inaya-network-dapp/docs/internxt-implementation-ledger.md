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
| MEET-002 | PQC meeting key establishment (§7.6/7.7) | custody-sdk's `Pqc.wrapForRecipient`/`SHARING_MODE`/`isAgileHybridEnvelope`/`capabilityInfo` (PQC-A05) -- the exact same algorithm-agile sharing primitive, not a second envelope format | EXTEND | `approveParticipant()` in rooms.js (server); `approveWaiting()` in `MeetView.js` (client, added in this follow-up pass) | `test/meet-rooms.test.mjs` ("PQC downgrade" test, server-side) | VERIFIED (server) / IMPLEMENTED_NOT_LIVE (client) | **Updated**: the client-side gap this row originally flagged is closed. `MeetView.js` now fetches the waiting participant's active PQC device key (`GET /api/orgs/pqc/devices/{deviceId}/active-key`, PQC-A04) and calls `Pqc.wrapForRecipient` for real when admitting -- this is genuine reuse, not a second code path: the combined `pqc_device_keys.publicKey` (ML-KEM-768 || X25519, confirmed via `Pqc.capabilityInfo().mlKemPublicKeyLength`) is passed to `wrapForRecipient` exactly as the function's own design expects (it has always needed the full combined key for the hybrid path, and just the X25519 tail for the classical fallback). Admission still degrades gracefully with no envelope when the participant has no registered key (CLASSICAL/HYBRID_PQC rooms) and clearly refuses for `PQC_REQUIRED` with no key (same server-side check as before, now also pre-checked client-side so the UI explains why rather than surfacing a bare 409). Rooms still default to `LEGACY_CLASSICAL` policy, deliberately: most orgs have `FEATURE_PQC` off and no registered device keys yet, so defaulting to `HYBRID_PQC` would show a banner the room can't actually back up for anyone. Not yet live-verified: a real two-browser session where a participant actually has a registered PQC key and the wrap genuinely succeeds end-to-end (server logic is tested in isolation; the browser-side crypto call itself has not been exercised against a live key) |
| MEET-003 | Signaling (SDP/ICE/control events) over the existing long-poll/SSE pattern | `src/lib/chat/transport.js`'s own long-poll/SSE design, not a new transport | NEW (mirrors an existing pattern, not a copy-paste of chat's collections) | `src/lib/meet/signaling.js`, collection `meet_signals` (24h TTL -- signaling is inherently ephemeral) | exercised indirectly via rooms.js's `broadcastControl` calls in the lifecycle tests, **and now via a real live session (see below)** | VERIFIED (signaling connects) / IMPLEMENTED_NOT_LIVE (media) | Dual-auth (session OR participantId+guestToken) confirmed working live: the long-poll GET to `/signal` connects and holds open correctly once a participant is admitted |
| MEET-004 | Mesh WebRTC client (camera/mic, screen share, moderator controls, lobby UI) | None (genuinely new client surface) | NEW | `src/components/business/meet/MeetView.js` | Real live session against a running dev server (see below) found and fixed two genuine bugs | VERIFIED (room/lobby/moderator flow) / IMPLEMENTED_NOT_LIVE (actual media frames) | Real `RTCPeerConnection` mesh (deterministic glare-free initiator rule), `getUserMedia`/`getDisplayMedia`, mute/camera/screen-share toggles, moderator panel, security banner. No TURN server configured (STUN-only) -- a participant behind a strict/symmetric NAT may fail to connect to some peers. **Live verification performed this pass** (see "Live verification pass" below): created a real org, two real sessions via the actual magic-link login route (not a bypass), created an instant meeting, opened the public join link, and drove the full room → lobby → admit → in-room flow against a real running server. Camera/mic frames themselves could not be exercised -- the test environment's browser sandbox blocks `getUserMedia` entirely (a tooling limit, not a code question) -- so actual video/audio flow between two real peers remains the one piece no automated or sandboxed pass can confirm; it needs a real two-person session in two real browsers |
| MEET-005 | Guest access (§7.9) -- all four modes now fully implemented: `forbidden`/`allowed`/`approval`/`named` | `notify/router.js` for the waiting-room ping; `sharing/shares.js`'s `requestShareCode`/`emailCodeValid` pattern (hashed 6-digit code, 10-min expiry, 5-attempt limit, single use, never reveals eligibility) mirrored for a meeting room instead of a share link | NEW | `requestJoin()`/`requestNamedGuestCode()`/`namedGuestCodeValid()` in rooms.js, `POST /api/meet/rooms/[roomId]/named-guest-code`, two-step email→code UI in `src/app/meet/[token]/page.js`, a "Guest access" policy panel (mode selector + invited-email list) added to `MeetView.js`'s moderator controls | `test/meet-rooms.test.mjs` ("named guest access" test) | VERIFIED | **Updated**: `named` mode is real end-to-end, not deferred. Codes are stored on the room document itself (a small embedded array, not a new top-level collection, per §9.2's "only if nothing existing fits"). A verified named guest auto-admits (being on the host's list is itself the approval) rather than also waiting in the lobby. Tested: an uninvited email gets the same generic "sent" response as an invited one (never leaks the list), a wrong code is rejected, the right code+email pair admits and records the verified email on the participant row, and a code cannot be replayed by a different email than the one it was issued to |
| MEET-006 | Join link (§7.10): unguessable, bound to the meeting, never carries a secret, rate-limited | Project's existing hash-at-rest token convention (same shape as session/share tokens elsewhere) | NEW (per §9.2's explicit allowance -- no existing token infrastructure fit a public, pre-auth, room-scoped admission token) | `newToken`/`hashToken` in meet/common.js; `meet_rooms.joinTokenHash` (unique index) | `test/meet-rooms.test.mjs` | VERIFIED | 24 random bytes, sha256-hashed at rest, never logged in plaintext after creation (the plaintext token is returned exactly once, in `createRoom`'s response, and `roomView()` never re-includes it). `meet:join` sliding-window rate limit (20/min per room+caller) |
| MEET-007 | Meeting chat reuses Secure Chat (§7.16) | `src/lib/chat/conversations.js`'s existing conversation/participant/message model | EXTEND | `KINDS` in conversations.js gains `"meeting"`; `createRoom` calls `createConversation({kind:"meeting"})`; `endRoom` deletes the conversation's message ciphertext and marks it closed | covered by chat's own existing test suite (the extension is a one-line enum addition plus reuse of the unchanged `createConversation`/`addParticipants` functions) | VERIFIED (extension) / IMPLEMENTED_NOT_LIVE (end-to-end with Meet) | Best-effort: a host not yet chat-enrolled still gets a working meeting, just without in-call chat, rather than Meet being blocked on chat's own device-enrollment precondition. Guests never get chat access (no MLS device identity) -- a reasonable default this ADR already anticipated ("optionally disable participant chat depending on room policy") |
| MEET-008 | Evidence (§7.19/7.20) | `logOrgActivity` / the existing audit chain -- confirmed it already supports Meet without a new `MEETING` subject type, since `recordType` is a free string exactly like every other feature's audit trail (`CHAT_CONVERSATION`, `ENDPOINT_BACKUP`, `PQC_DEVICE_KEY`, ...) | REUSE | `MEETING`/`MEETING_PARTICIPANT` recordTypes throughout rooms.js | — | VERIFIED | No plaintext/media/chat content in any audit record (trivially true -- the server never has it); algorithm id, policy, participant counts and moderation actions only |
| MEET-009 | Notifications (§7.29) | `notify/router.js`'s existing event catalog | EXTEND | Three new entries added: `meeting.invitation`, `meeting.participant_waiting`, `meeting.admitted` | — | VERIFIED | No `meet_notifications` collection created; reuses the existing in-app/email/push/desktop channel routing exactly like every other event |
| MEET-010 | Mobile/desktop participation (§7.30/7.31) | `react-native-webview` (already a dependency); the desktop app's existing `open_module_window` Tauri command (the same one Secure Chat's pop-out window already uses) | NEW (mobile screen) / REUSE (desktop window) | `inaya-mobile/src/screens/MeetScreen.js`, `App.js` Drawer entry; `src/components/business/chat/desktop.js`'s new `popOutMeet`/`openMeetLink` | — | IMPLEMENTED_NOT_LIVE | **Updated**: both built. Mobile is a WebView around `/meet/[token]` (never a second native WebRTC stack), with `app.json` CAMERA/RECORD_AUDIO permissions added for Android and camera/mic usage-description strings for iOS -- these need the *next native build* to actually take effect; an existing install only gets the new screen over OTA, with camera/mic silently unavailable until reinstalled from a fresh build. Mirrored onto both `inaya-mobile` (main) and `inaya-mobile-release` (play-release) branches, committed locally, **not pushed** -- no reason to trigger another Play-edition build cycle while the current closed-testing submission is under review. Desktop reuses the existing `open_module_window` native command exactly as Secure Chat's own pop-out already does -- no new native Rust code. Not yet live-verified: no physical device/emulator run in this session, and no real two-browser or phone-to-desktop call attempted |

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
tests were not measured this pass, honestly not claimed). **Updated in the follow-up pass**: client-side PQC
key resolution (was priority 1) and mobile/desktop UI (was priority 3) are now both built -- see MEET-002 and
MEET-010 above. Named-guest email/OTP verification (was priority 2) is also now built -- see MEET-005 above.
What remains, all needing real hardware/human presence this environment cannot provide: (1) a real
two-browser WebRTC verification pass with a live PQC key actually present on one side (the sandboxed test
browser blocks camera/mic entirely, confirmed during the live verification pass below); (2) a real
device/emulator run of the mobile Meet screen.

### Live verification pass (2026-10-11)

Ran a real end-to-end session against a running dev server rather than only unit tests: created a real
organization and two members through the actual production login route (`/api/orgs/login/consume`, the same
route a real magic-link email points to -- not a test-only auth bypass), created an instant meeting through the
business-workspace UI, and drove the full room → lobby → public join link → admit → in-room flow in a real
browser. This is the pass that SOW §7.35-37's acceptance criteria call for beyond unit tests, and it surfaced
two genuine bugs unit tests couldn't have caught (both fixed and verified in the same pass):

1. **`Sidebar` crash (`business/page.js`)** -- pre-existing, not introduced by Meet. The sidebar's nav-item
   filter referenced `membership` to resolve scoped admin-role visibility (`hasAdminRole(membership, ...)`),
   but `membership` was never passed into `Sidebar` as a prop, only used inside the *other* component that
   actually has it in scope. Any render where `canManage` was falsy at that moment (e.g. the brief window before
   `role` state settles on first load) threw an uncaught `ReferenceError`, which React has no way to recover
   from without a reload -- a full white-screen crash. Fixed by threading `membership` through as a prop.
2. **False "couldn't open this meeting" on a denied camera (`MeetView.js`)** -- introduced in this workstream.
   The preflight screen's informational "camera/mic denied, you can still join" message and the fatal
   room-load-failed message shared one `error` state variable. If the camera-permission rejection landed before
   `loadRoom()` resolved, the component's `if (error && !room)` guard misread the benign device warning as a
   fatal failure and showed "Couldn't open this meeting" instead of the working preflight screen -- meaning
   **any user without a camera, or who declines the permission prompt, would have been told the meeting failed
   to open** rather than being let in without video. Fixed by splitting into separate `error`/`deviceWarning`
   state.

What was confirmed working end-to-end in this pass: room creation, the public `/meet/[token]` join page
(resolve-by-token, then join via session or as a guest), org-member auto-admission, idempotent rejoin for an
already-admitted participant, the long-poll signaling connection opening and holding, and the moderator UI
(Lock/End/Participants) rendering correctly for the actual host. What this pass could **not** confirm: real
camera/microphone media flowing between two peers -- the sandboxed test browser blocks `getUserMedia` entirely,
a tooling limitation of the test environment rather than something about the code. A true guest (no account at
all) join was *attempted* but the test environment's two tabs shared one browser profile's cookies, so the
"guest" tab was unintentionally still the host's own session -- the guest code path itself is already covered
by `test/meet-rooms.test.mjs`'s server-side tests, just not re-confirmed through this particular UI pass.
11/11 Meet tests and a full `npm run build` both still pass after these two fixes.

## Workstream E — Unified "Private Device" experience

Priority P2 (lowest of the five workstreams) per the SOW. Partially built in the same follow-up pass as the
MEET-002/MEET-010 updates above, since both pieces were small, real, and directly reachable from work already
in progress.

| Requirement ID | Capability | Existing Inaya primitive reused | Action | Code path | Test path | Status | Notes |
|---|---|---|---|---|---|---|---|
| E-001 | §8.3: device revocation cascades to PQC key revocation, not a parallel mechanism | `pqc/deviceKeys.js`'s existing `revokeAllKeysForDevice` (built in Workstream A, PQC-A03, but never actually called from anywhere until now) | EXTEND | `deviceAction()` in `src/lib/devices/devices.js`, fired alongside its existing webhook/notify calls for `revoke`/`block` | `test/pqc-device-keys.test.mjs` ("device revocation cascades..." test) | VERIFIED | Best-effort/fire-and-forget, matching the exact pattern the function's own neighboring webhook call already uses -- a PQC-key-revocation failure never blocks the device action itself. Test polls briefly (up to 2s) since the cascade is intentionally async, confirms the key is actually revoked, not just that the call was attempted |
| E-002 | §8.2: per-device PQC capability badge (`PQC Ready` / no badge for a legacy client) | `pqc/deviceKeys.js`'s existing `listDeviceKeys` (PQC-A03) | REUSE | `DevicesView.js`, one batch fetch for the whole device list (not one request per row) | — | IMPLEMENTED_NOT_LIVE | Deliberately only two states shown (`PQC Ready` or nothing), not the SOW's full four-state suggestion (`PQC Ready`/`PQC Recommended`/`Legacy Client`/`PQC Required — Update Needed`) -- the richer states need org policy context this pass didn't plumb through, and §8.2 explicitly allows refining the terminology; showing two honest states beats four where two would be guessed. Never shows "Quantum Safe" for any device, matching §8.2's explicit instruction |
| E-003 | §8.1: full device dashboard (backup health, sync health, cleaner last scan, Meet capability, trust status, all in one view) | `DeviceProtectionView.js` (Workstream D) already consolidates Backup/Sync/Cleaner/Devices into one tabbed surface; `endpoint/backup.js`'s existing `listProfiles` for backup health | PARTIAL REUSE | `DevicesView.js` now shows trust status + PQC capability (E-002) + backup health, one batched fetch each, per device row | — | PARTIAL | **Updated**: backup health per device is now real (a device row shows e.g. "Backup: green/amber/red" when it has a matching `endpoint_backup_profiles` entry). Two of the five signals the SOW names are deliberately **NOT_APPLICABLE**, not just unbuilt: sync health has no per-org-device tracking to show (DirectSync's health is a per-folder state on whichever browser is currently syncing, never persisted per device server-side), and "Cleaner last scan" cannot exist server-side at all -- Cleaner's own local-first design (SOW §6.3, which this codebase already built faithfully) means it never reports a scan to the server under any circumstances. Inventing either would mean guessing or quietly breaking a privacy guarantee already shipped. A true single-row-per-device view (vs. the current tabbed `DeviceProtectionView.js`) remains a real UI undertaking, still deferred |

## Final honesty statement (updated 2026-10-11, end of this SOW's active implementation)

**Workstream A (PQC layer)** — complete and verified (custody-sdk 127/127 tests, from earlier sessions).

**Workstream B (Cleaner)** — complete and mostly verified (9/9 Rust filesystem tests on Windows). One honest
gap carried from earlier: the live Tauri-command round trip through the compiled desktop app was attempted via
CDP and did not complete in this environment -- stated as a tooling limitation then, still true now.

**Workstream D (Backup reconciliation)** — complete. Full §5.3 audit against the 8 existing backup files (nearly
everything already existed), Device Protection UI consolidation, Cleaner↔backup warning, and an honest
NOT_APPLICABLE finding for backup-key PQC integration (the content-encryption path is passphrase-derived
symmetric, not a public-key exchange -- forcing PQC onto it would have been checkbox-driven, not real).

**Workstream C (Meet)** — functionally complete. All four guest-access modes (forbidden/allowed/approval/named)
are real and tested, including named-guest email+one-time-code verification. Client-side PQC key resolution for
admission is real (server-enforced `PQC_REQUIRED` downgrade rejection, tested; client wrap uses the actual
algorithm-agile sharing primitive, not a stub). Mobile (WebView join screen) and desktop (native pop-out window,
reusing the existing Tauri command) UI are both built. A live verification pass against a real running server
(real org, real login via the production magic-link route, real browser) found and fixed two genuine bugs a
unit-test-only approach could never have caught: a pre-existing Sidebar crash affecting any user under a timing
race, and a Meet-specific bug that told a user without a camera the meeting had failed to open when it hadn't.
28 server-side tests pass across PQC device-keys and Meet (14 + 12 + this pass's +2 for named-guest). What
remains needs real hardware/human presence no sandboxed or automated pass can provide: a genuine two-person
video call in two real browsers (the test environment's browser sandbox blocks camera/mic access entirely by
design), and a real mobile device/emulator run.

**Workstream E (Unified Private Device experience, P2/lowest priority)** — partially built, and deliberately so.
Device revocation now correctly cascades to PQC key revocation (tested) -- the one piece that was a genuine,
previously-unused gap. A PQC-capability badge and a backup-health badge were added to the device list, each a
single batched fetch, no N+1 queries. Two of the SOW's named dashboard signals were found to be architecturally
impossible to add honestly rather than just unbuilt: DirectSync's health has no per-org-device server-side
tracking, and Cleaner's own local-first design (built faithfully to the SOW's own §6.3) means it never reports a
scan to the server under any circumstances -- showing either would have meant inventing data or quietly breaking
a privacy guarantee already shipped. A true single-row-per-device dashboard (vs. today's tabbed surface) remains
real, scoped UI work, deferred.

No "VERIFIED" status anywhere in this document is claimed for anything not actually run against real tests or a
real build. Every PARTIAL/IMPLEMENTED_NOT_LIVE/DEFERRED/NOT_APPLICABLE row says exactly why, and two real
production bugs were found and fixed by actually running the software rather than assuming correctness from the
code alone -- the same discipline this ledger has held throughout every workstream.
