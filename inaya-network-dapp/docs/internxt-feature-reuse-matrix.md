# Internxt-inspired expansion — feature reuse matrix

Per-behavior classification against the SOW's own checklists (§2.1, §5.3). `REUSE` = existing primitive, unchanged. `EXTEND` = existing
primitive, additive change. `NEW` = genuinely absent, built fresh. `DEFERRED` = explicitly out of scope for this pass (recording,
transcription, AI monitoring, RAM optimization, full-disk silent backup).

## PQC

| Behavior | Action | Primitive |
|---|---|---|
| Content encryption (files) | REUSE | AES-256-GCM, `custody-sdk/src/crypto.js` — unchanged, PQC never touches this layer |
| Key establishment/wrapping for sharing | EXTEND | `src/lib/chat/conversations.js` sharing envelope becomes algorithm-agile |
| PQC primitive | NEW | `custody-sdk/src/pqc/provider.js` on `@noble/post-quantum` ML-KEM-768 |
| Device key registry | NEW | `pqc_device_keys` collection (audited: no existing collection holds device-scoped public-key lifecycle state) |
| Passkey backup/restore | REUSE | `custody-sdk/src/passkeyBackup.js` remains the primary recovery primitive; PQC device state restores only after it authenticates the owner |
| Audit of PQC operations | REUSE | `src/lib/auditChain.js` — new event types, same chain |

## Computer Backup (Workstream B — reconciliation only)

| Behavior (SOW §5.3) | Classification |
|---|---|
| Folder selection, manual backup, pause/stop/resume | `ALREADY_EXISTS` — `endpoint/backup.js` (Competitive Expansion) |
| Recurring schedule | `ALREADY_EXISTS` — `cloudBackupScheduler.js` |
| Backup progress, files seen/changed/failed, retry queue | `ALREADY_EXISTS` — `endpoint/backup.js` |
| Restore to original/alternate location | `ALREADY_EXISTS` — `endpoint/backup.js` |
| Web access to backup content | `ALREADY_EXISTS` — Business Workspace |
| Device identity, multi-device | `ALREADY_EXISTS` — Competitive Expansion device records |
| Integrity verification, ransomware-safe recovery | `ALREADY_EXISTS` — Competitive Expansion ransomware signals + `backupHealth.js` |
| One coherent user-facing surface (not 4 scattered screens) | `MISSING` → closed by this SOW: a single "Device Protection" view |
| PQC-encrypted new backup sessions | `MISSING` → closed in Workstream A integration phase |
| Cleaner cannot silently delete an actively-backed-up file | `MISSING` → closed in Workstream B (Cleaner) |

No new backup collection, scheduler, or engine. Full per-file audit will be appended here as Workstream D's reconciliation pass runs.

## Cleaner

| Behavior | Action |
|---|---|
| Device identity for scoping | REUSE — existing device records |
| Settings/encrypted-config storage | REUSE — existing desktop secure-storage pattern (OS credential store, same as the passkey) |
| Local file scan, temp/duplicate detection, protected paths, trash-not-delete | NEW — no equivalent exists anywhere |
| Desktop shell | REUSE — lives inside `inaya-desktop`, not a new application |

## Meet

| Behavior | Action |
|---|---|
| In-call chat | EXTEND — `src/lib/chat/conversations.js`'s `kind` field gets an ephemeral meeting value, not a second message system |
| Identity/session auth | REUSE — existing org membership + session auth |
| Notifications (invite, waiting, admitted, started, ended) | REUSE — `src/lib/notify/router.js`, new event types only |
| Audit/Evidence | REUSE — audit chain + Evidence Graph, new `MEETING` subject only if the existing registry cannot already express it (to confirm during Workstream C) |
| Attachments | REUSE — existing encrypted object/share mechanism, short-lived grants, never a new storage engine |
| Room lifecycle, signaling, media transport | NEW — no equivalent exists anywhere |
| Key establishment | EXTEND — consumes the new PQC layer (Workstream A) for `HYBRID_PQC`/`PQC_REQUIRED` policy |

## Explicitly not built (SOW §19, §7.26–28)

Meeting recording, meeting transcription, AI analysis of meeting content, a second cloud-storage/sharing/chat/device/notification/audit
system under any name, arbitrary process killing as "RAM optimization," full-disk silent backup, full-OS remote wipe, any mainnet
dependency, any claim that blockchain signatures are post-quantum-safe.
