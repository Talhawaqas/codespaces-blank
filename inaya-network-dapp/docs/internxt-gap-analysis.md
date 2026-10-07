# Internxt-inspired expansion — Phase 0 gap analysis

SOW: `INAYA_Internxt_ClaudeCode_SOW.md`. Companion: `INAYA_Filen_FileCloud_ClaudeCode_SOW.md` (already built — Secure Chat, Secure Notes,
Sharing 2.0, Governance, Device Control, Sovereign Gateway, live behind feature flags since 3–5 October 2026). This document is the
required-before-code audit (SOW §3.1.3-4): every Internxt-like capability classified as already existing, extendable, or genuinely new.

## Method

Repository search across `src/`, `custody-sdk/`, `inaya-desktop/`, `inaya-mobile/` for every primitive the SOW's §0.2 says must be reused,
plus the four target product areas (PQC, Computer Backup, Cleaner, Meet).

## Findings

### Already exists — reuse unchanged

| Capability | Where |
|---|---|
| Client-side AES-256-GCM encryption, PBKDF2 key derivation | `custody-sdk/src/crypto.js` |
| X25519 + HKDF-SHA256 + XChaCha20-Poly1305 sharing primitives | `custody-sdk/src/crypto.js` |
| Encrypted sharding (`disperseAndSlice`/`reconstructAndDecrypt`) | `custody-sdk` |
| Passkey backup/restore | `custody-sdk/src/passkeyBackup.js` |
| Secure Chat (MLS, RFC 9420) — conversation model, device enrollment, notifications | `src/lib/chat/**` (see `docs/architecture/e2ee-chat-key-management.md`) |
| Device inventory/control | Competitive Expansion Workstream G (device records, revoke/block/wipe) |
| Audit chain | `src/lib/auditChain.js` |
| Evidence Graph | `src/lib/evidence.js` + per-feature integration files |
| Notifications | `src/lib/notify/router.js` |
| Org/session auth, `requireMembership()`, permission gates | `src/lib/orgs.js` and route-layer convention used by every `/api/orgs/**` route |
| API-key auth for public routes | `src/lib/api-keys.js` |

### Already exists — extensive, must be reconciled not cloned (Workstream B of this SOW)

Backup/endpoint-protection is not one engine but eight real, separate files: `src/lib/backupEngine.js` (core backup + redundancy across
Pinata/Filebase), `backupHealth.js` (status/health), `cloudBackupScheduler.js` (recurring cloud-to-Inaya backup), `endpoint/backup.js`
(desktop endpoint backup — watched folders, restore jobs, from the Competitive Expansion SOW), `nas/backup.js` (Sovereign NAS backup),
`watcherBackup.js`, `nftBackupAuth.js`, `backupCryptoAndCredentials.js`. DirectSync (`inaya-desktop` Tauri commands, `directsync_*`) is a
separate but adjacent local-folder-watcher system. None of this is duplicated; see `docs/internxt-feature-reuse-matrix.md` for the
per-behavior classification against the SOW's §5.3 checklist.

### Genuinely absent — new in this SOW

| Capability | Confirmed absent by | Plan |
|---|---|---|
| ML-KEM / Kyber / any post-quantum primitive | Zero matches for `ml-kem`, `kyber`, `post-quantum`, `pqc` anywhere in `src` or `custody-sdk` source | Workstream A |
| WebRTC peer connections / SFU / media transport | The only existing real-time-audio code, `src/hooks/useVoiceSession.js`, is browser-to-Gemini-Live over Gemini's own WebSocket protocol (fixed-format raw PCM) — not WebRTC, nothing reusable for media transport | Workstream C |
| Local desktop junk/duplicate-file scanner | No equivalent anywhere in `inaya-desktop` | Workstream B |
| Private video meetings (rooms, scheduling, moderation, guest admission) | No equivalent product surface | Workstream C |

### Existing crypto library family — what the PQC layer builds on

Every cryptographic primitive in this codebase already comes from Paul Miller's `@noble/*` family: `@noble/hashes` (SHA-2, HKDF, PBKDF2),
`@noble/ciphers` (AES-GCM, XChaCha20-Poly1305), `@noble/curves` (X25519). `@noble/post-quantum` (npm, v0.7.1 confirmed live) implements
ML-KEM (FIPS 203), ML-DSA and SLH-DSA in the same audited, pure-JS/TS, zero-dependency style — the natural, consistent choice rather than
introducing a new crypto library family or a native/WASM dependency.

### Chat conversation model — the extension point for Meet's ephemeral chat

`src/lib/chat/conversations.js`'s `createConversation()` already accepts a `kind` parameter and an `external` flag. Per SOW §7.16, this is
the field to extend (not fork) for an ephemeral meeting-scoped channel, rather than a second message system.

### Desktop native-command pattern — the template for Cleaner's Tauri commands

`inaya-desktop/src-tauri`: `build.rs` declares a `COMMANDS` manifest consumed by `tauri_build::AppManifest`; `capabilities/default.json`
grants each command's generated `allow-<command>` permission to the site's remote origin; every sensitive `#[tauri::command]` fn in
`src/lib.rs` additionally calls `verify_trusted_origin()` itself. 20+ existing commands (DirectSync, drive mount, notifications, passkey
storage) establish this pattern; Cleaner's commands follow it exactly.

### Real-time transport constraint — inherited, not new

Secure Chat's real-time layer runs on long-poll/SSE, not WebSockets, specifically because Vercel serverless functions cannot hold a
persistent connection. This constrains Meet's signaling design; see `docs/architecture/meet-architecture-adr.md`.

## Conclusion

Three genuinely new systems (PQC layer, Cleaner, Meet) plus one integration/reconciliation pass (Computer Backup), exactly matching the
SOW's own §2.2 analysis. No existing subsystem is duplicated. Full per-requirement classification in
`docs/internxt-feature-reuse-matrix.md` and `docs/internxt-implementation-ledger.md`.
