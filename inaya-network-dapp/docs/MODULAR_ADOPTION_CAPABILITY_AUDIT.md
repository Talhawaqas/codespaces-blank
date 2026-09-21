# Modular Enterprise Adoption Features — Capability Audit

**SOW:** DirectSync + Zero-Knowledge Data Room Templates + Smart Cloud Backup & Health Scheduler + Interactive What-If Scenario Studio.
**Status:** Written after Features 2, 3, and 4 were built and before Feature 1 (DirectSync) implementation began — the audit findings below were gathered before each feature's work, this document consolidates them into the single artifact the SOW requires (§5).

Classification legend: **ALREADY IMPLEMENTED** / **PARTIALLY IMPLEMENTED** / **MISSING — GENUINE GAP** / **NOT APPROPRIATE FOR INAYA** / **EXTERNAL DEPENDENCY / HARDWARE REQUIRED** / **ARCHITECTURAL DECISION REQUIRED**.

## Audit Matrix

| Capability | Existing | Reusable | Partial | Missing | Action |
|---|---|---|---|---|---|
| Local folder watcher | No | — | — | Yes | Build via `notify` + `notify-debouncer-full` (Rust) — no existing primitive anywhere in the repo (Rust or JS) |
| Background DirectSync service | Partial (tray/background pattern exists) | Yes (`inaya-desktop`'s tray + minimize-to-tray) | Yes | Partial | Extend `inaya-desktop`'s existing background/tray architecture, not a 5th native app |
| Offline queue | No | — | — | Yes | Build local SQLite state store (`rusqlite`) — no local sync-state persistence exists anywhere on the desktop side |
| Resume after interruption | No (local); design precedent exists server-side | Yes (precedent) | — | Yes | Build, modeled on `cloudBackupScheduler.js`'s `diffAgainstLastSync`/`backupObjectState` pattern |
| File change detection | No | — | — | Yes | Build via `notify` crate events, debounced |
| Duplicate-safe upload | No (local); S3-compat destination is idempotent by key | Yes (destination) | — | Yes | Build local dedup via content hash + prior-state comparison before each PUT |
| Drive integration | Yes | Yes | — | No | `inaya-drive-core`'s `S3Client` (already does put/head/list against real `/api/s3`) — reused directly as DirectSync's upload client |
| S3 API integration | Yes | Yes | — | No | `/api/s3/[bucket]/[...key]` route, `s3-compat/credentials.js`, `s3-compat/store.js` — reused unchanged |
| Secure desktop share-link creation | Yes | Yes | — | No | `s3-compat/signedUrl.js`'s `createSignedUrl`/`verifySignedUrl` (HMAC-SHA256, org-scoped, 7-day cap) |
| Existing Data Room | Yes | Yes | — | No | `external-data-room.js` (Feature 2 built on this directly) |
| NDA gating | Yes | Yes | — | No | `external-data-room.js`'s `ndaRequired`/`acceptRoomNda` (extended, not forked, for Feature 2) |
| Magic links | Yes | Yes | — | No | `magicLinks` collection, existing session-resolution flow |
| Temporary signed URLs | Yes | Yes | — | No | `s3-compat/signedUrl.js` |
| Google authentication | Yes | Yes | — | No | Existing OAuth app registration, not re-audited for DirectSync (desktop app auth uses a different path — see below) |
| Data Room templates | No | — | — | Yes (built, Feature 2) | `dataRoomTemplates.js` — extends `external-data-room.js`, does not fork it |
| Viewer audit events | Yes | Yes | — | No | `logOrgActivity`/org activity log, reused for every new feature's audit trail |
| Compliance evidence export | Yes | Yes | — | No | `evidenceExporter.js`'s `canonicalizeForExport` + sha256 pattern, reused for Data Room (`dataRoomEvidence.js`) and Digital Twin simulations |
| Cloud migration engine | Yes | Yes | — | No | `inaya-migration-agent` package — reused via `file:` dependency for Feature 3, not rewritten |
| Scheduled jobs | Partial (Vercel cron exists; no per-org-configurable job concept before this SOW) | Yes (pattern) | Yes | — | `vercel.json` cron pattern + `CRON_SECRET` gate reused unchanged for `/api/cron/cloud-backup-run` |
| Cloud credential storage | No (server-side, for a customer's own external cloud secrets) | — | — | Yes (built, Feature 3) | `backupCryptoAndCredentials.js`, mirroring `integrationCrypto.js`'s envelope-encryption shape with its own dedicated key |
| AWS recurring backup | No | — | — | Yes (built, Feature 3) | `cloudBackupScheduler.js` orchestrating `inaya-migration-agent`'s real `createAwsSource` |
| Azure recurring backup | No | — | — | Yes (built, Feature 3) | Same orchestration, `createAzureSource` |
| GCS recurring backup | No | — | — | Yes (built, Feature 3) | Same orchestration, `createGcsSource` |
| Backup health state | No | — | — | Yes (built, Feature 3) | `computeHealthStatus()` — HEALTHY/WARNING/DEGRADED/FAILED/PAUSED/UNKNOWN |
| Checksum verification | Yes (within migration engine) | Yes | — | No | `runMigration()`'s own real HEAD-after-PUT size-verified integrity check, reused unchanged |
| Integrity reports | Partial | Yes (run-history rows) | Yes | — | `backupRuns` collection + run-history API; a periodic digest report (§8.9) not built this pass |
| Email notifications | No (org notifications exist; email does not) | Yes (in-app) | Yes | Partial | `createNotification` (in-app) reused; email explicitly documented as a dependency, not silently invented |
| Digital Twin API | No | — | — | Yes (built, prior session) | `digitalTwin.js`/`digitalTwinSimulate.js` |
| Simulation engine | Yes (prior session) | Yes | — | No | Reused unchanged by the What-If Studio UI (Feature 4) |
| Scenario storage | Yes (prior session) | Yes | — | No | Org activity log entries (`DIGITAL_TWIN_SIMULATION` record type) |
| Snapshot model | Partial | Yes (integrity hash + versions) | Yes | — | `MODEL_VERSION`/`RULES_VERSION` + `integrityHash`, not a full point-in-time snapshot store |
| Baseline comparison | Yes (built, Feature 4) | — | — | Yes | `WhatIfStudioView.js`'s current-vs-simulated panel |
| What-If UI | No | — | — | Yes (built, Feature 4) | `WhatIfStudioView.js` |
| Simulation evidence | Yes (prior session, extended Feature 4) | Yes | — | No | Integrity hash + `logOrgActivity`, reused |
| Real-action handoff | No | — | — | Not built this pass | Deferred — no simulation currently proposes a real action; would reuse the existing `PENDING_APPROVAL`/controlled-execution flow when a real use case appears |

## DirectSync-Specific Findings (Feature 1, audited immediately before implementation)

| Capability | Existing | Reusable | Partial | Missing | Action |
|---|---|---|---|---|---|
| Native background/tray process pattern | Yes | Yes | — | No | `inaya-desktop`'s `mount_inaya_drive`/`unmount_inaya_drive` spawn-and-track idiom, tray minimize-to-background behavior |
| Local folder watching | No | — | — | Yes | `notify` + `notify-debouncer-full` crates — genuine gap, nothing in the repo does this today |
| Local sync/offline-state persistence | No (server-side Mongo analog only) | Yes (design precedent) | — | Yes | SQLite via `rusqlite`; schema modeled on `cloudBackupScheduler.js`'s `backupObjectState` shape |
| Secure desktop credential storage | Yes | Yes | — | No | `keyring` crate, already used for passkey storage (`store_passkey_secure`/`retrieve_passkey_secure`/`clear_passkey_secure`) |
| Secure/temporary link generation | Yes | Yes | — | No | `s3-compat/signedUrl.js`'s HMAC-SHA256 scheme — same algorithm ported to Rust for local, offline link generation (no new signing mechanism) |
| Upload destination client | Yes | Yes | — | No | `inaya-drive-core`'s `S3Client`/`sigv4.rs` — the exact same SigV4-signing Rust S3 client `inaya-drive-helper`/`inaya-drive-helper-linux` already use against the real `/api/s3` endpoint |
| Headless/background auth (no webview open) | Partial | Yes (S3-compat credential is sufficient) | Yes | — | DirectSync authenticates its uploads with the org's own S3-compat `accessKeyId`/`secretAccessKey` (the same credential class already used for Drive mounting) — no separate device-token flow needed, since every DirectSync API call is an S3-compat call |
| Test convention for this part of the codebase | Yes (established, thinner than the rest of the repo) | Yes | — | No | Inline `#[cfg(test)] mod tests`, pure-logic tests un-ignored, real-OS-resource tests marked `#[ignore]` — matches `inaya-desktop`'s existing passkey round-trip test |

## Explicit Scope Decision — DirectSync Background Model

DirectSync runs as a background task inside `inaya-desktop`'s existing Tauri process, started on app launch, surviving window close via the app's existing minimize-to-tray behavior (`WindowEvent::CloseRequested` → `prevent_close()` + `hide()`, already implemented) — not as a fifth standalone native service/daemon independent of the desktop app being open at all.

This directly reuses real, already-built background/tray infrastructure rather than building a new OS-level service installer (Windows Service / systemd unit), matching §10.6/§10.7's instruction not to create isolated mini-products. It satisfies the SOW's actual requirement — "the user should not need to manually open the Web3 dApp for routine backup operations" (§6.1) is satisfied because DirectSync runs automatically once `inaya-desktop` is running, which the user can set to launch at login — but it does not satisfy a stronger, unstated requirement of "runs even if the desktop app itself was never started." That distinction is documented here explicitly rather than glossed over, per §20's requirement to state exact support status.

## Mandatory Rule Compliance

No row above classified **ALREADY IMPLEMENTED** was reimplemented. Every feature built in this SOW (Features 2, 3, and the DirectSync work that follows) extends or calls an existing system — `external-data-room.js`, `inaya-migration-agent`, `digitalTwinSimulate.js`, `inaya-drive-core`'s `S3Client`, `s3-compat/signedUrl.js`, the `keyring` crate's existing passkey pattern — rather than forking or rebuilding it.
