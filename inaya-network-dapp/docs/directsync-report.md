# Inaya DirectSync

**Status:** Implemented and tested (Windows, real end-to-end). **Date:** September 2026.
**SOW:** Modular Enterprise Adoption Features, Feature 1 (final feature of the SOW — see `MODULAR_ADOPTION_CAPABILITY_AUDIT.md` for the full audit this and every other feature in the SOW was built against).

## What DirectSync Is

A background local-folder watcher inside the `inaya-desktop` Tauri app: add a folder, and every new or changed file in it is automatically, incrementally uploaded into Inaya via the existing S3-compatible API — duplicate-safe, resumable across restarts, and running as long as the desktop app is open (see the Scope Decision below for exactly what that does and doesn't guarantee).

## Phase 0 Audit — What Already Existed

Full detail in `MODULAR_ADOPTION_CAPABILITY_AUDIT.md`'s DirectSync-specific table. Summary of the two genuine gaps versus everything reused:

| Capability | Status | Treatment |
|---|---|---|
| Local folder watching | **Genuine gap** — nothing in the repo did this | Built with `notify` + `notify-debouncer-full` |
| Local durable sync-state/queue | **Genuine gap** — no local persistence existed on the desktop side (only a same-shaped server-side Mongo analog in `cloudBackupScheduler.js`) | Built with SQLite (`rusqlite`), schema modeled on that same-shaped precedent |
| Native background/tray process pattern | Exists | Reused — `inaya-desktop`'s existing `mount_inaya_drive`/tray/minimize-to-background architecture |
| Upload destination client (S3 signing, PUT/HEAD/DELETE against `/api/s3`) | Exists | Reused directly — `inaya-drive-core`'s `S3Client`, the same client `inaya-drive-helper`/`inaya-drive-helper-linux` already use |
| Secure desktop credential storage | Exists | Reused — the `keyring` crate, already used for the master-node passkey |
| Secure/temporary link generation | Exists (`s3-compat/signedUrl.js`) | Not used in this pass — deferred, see Known Limitations |
| Headless/background auth | Partial (webview session cookie is a dead end for a process with no window) | Resolved without new auth machinery — DirectSync authenticates every upload with the org's own S3-compat `accessKeyId`/`secretAccessKey`, the same credential class already used for Drive mounting |

No existing system was forked or rebuilt. `inaya-drive-core` is linked as a path dependency exactly the way `inaya-drive-helper-linux` already links it — the third consumer of that shared crate, not a fourth reimplementation of an S3 client.

## Scope Decision — Background Model

DirectSync runs as a background task inside `inaya-desktop`'s existing process, started on app launch, surviving window close via the app's already-implemented minimize-to-tray behavior. This is a deliberate choice to reuse real, already-built infrastructure rather than build a fifth standalone native service (a Windows Service / systemd unit with its own installer). It satisfies the SOW's actual requirement — routine backups don't require manually opening the web dApp — but **not** a stronger, unstated one: DirectSync does not run if `inaya-desktop` itself was never started. That distinction is stated here plainly, matching the SOW's own requirement (§20) to report exact support status rather than a generic "supported" label.

## What Was Built

- **`inaya-desktop/src-tauri/src/directsync.rs`** (new) — the engine:
  - `SyncStateDb` — SQLite-backed `folders` and `sync_state` tables (local path, size, mtime, content hash, destination key, upload state, retry count, last error, last synced time — the exact conceptual model the SOW's own §17 `DirectSyncFileState` describes).
  - `SyncEngine::sync_one_file` — hashes the file (SHA-256), compares against the last known `DONE` state for that exact path, skips if both size **and** hash match (never trusts mtime alone), otherwise uploads via `S3Client::put_object` and verifies via `head_object` (byte-size check) before marking the row `DONE`.
  - `SyncEngine::handle_rename` — a local rename repoints the existing state row (no wasted re-hash/re-diff of unchanged content) but still physically relocates the object in Inaya (PUT under the new key, best-effort DELETE of the old one) — a real gap the end-to-end test caught during development (see below).
  - `SyncEngine::handle_delete` — marks the row `LOCALLY_DELETED` and does **not** touch the remote copy. Stated plainly: this is backup semantics (A → Inaya), not mirror semantics — a local delete must never destroy the only remaining copy of a file.
  - `start_watching_folder`/`stop_watching_folder` — one thread per watched folder, using `notify-debouncer-full` to coalesce the OS's own duplicate/rapid-fire filesystem events into single logical changes, and to pair a rename's "from"/"to" paths when the OS can correlate them (falling back to a clean delete+re-upload when it can't — a disclosed, reasonable fallback, not a silent gap).
  - Every folder does a full recursive scan on both first-add and app-restart *before* live events resume, so a change made while the app was closed is still caught (restart recovery, SOW §6.6).
- **`inaya-desktop/src-tauri/src/lib.rs`** (modified) — 10 new Tauri commands (`directsync_store_credential`, `directsync_credential_configured`, `directsync_clear_credential`, `directsync_pick_folder`, `directsync_add_folder`, `directsync_remove_folder`, `directsync_pause_folder`, `directsync_resume_folder`, `directsync_list_folders`, `directsync_list_queue`, `directsync_retry_failed`), all origin-verified via the file's existing `verify_trusted_origin` defense-in-depth idiom. `DirectSyncState` is initialized in `.setup()` — restoring the credential from the OS keychain and resuming every enabled folder's watcher — and torn down (all watcher threads stopped) on tray Quit, mirroring the existing `DriveState` pattern exactly.
- **`inaya-network-dapp/src/components/business/DirectSyncView.js`** (new) — folders, status, queue, errors, destination, and settings, matching the SOW's own §16 required-views list. Calls the Tauri commands above via `window.__TAURI__.core.invoke()`, the same pattern the app's existing pending-approvals/security-feed pollers already use. DirectSync has no meaningful browser-only equivalent (there's no folder to watch inside a tab), so the view degrades to an honest "requires the Inaya Desktop app" message with a link to the download page when it isn't running inside the desktop webview, rather than pretending to offer folder sync from a browser.

## A Real Bug Found and Fixed During Testing

The first version of `handle_rename` only updated the local SQLite row's `destination_key` — it never actually relocated the object in Inaya. The real end-to-end test (below) caught this directly: after a rename, `head_object` for the new key returned nothing, because the object was still sitting under the old key. Fixed by having `handle_rename` read the (still-unchanged) local bytes and PUT them under the new key, then best-effort DELETE the old key — real network operations, not skipped just because the content itself didn't change.

## Testing

`directsync.rs`'s own `#[cfg(test)] mod tests`, matching this part of the codebase's established (thinner, Rust-native) test convention — pure-logic tests un-ignored, real-resource tests marked `#[ignore]`:

- **7 un-ignored unit tests**: relative-key computation (prefix joining, Windows-separator normalization, outside-root rejection), duplicate-safety logic (size+hash must both match — a same-size-different-content file must never be treated as unchanged), content-hash determinism, and the SQLite state store's own queue/done/failed/requeue and rename transitions.
- **1 `#[ignore]`d real end-to-end test**, run manually against a genuinely running local dev server and a real, disposable S3-compat credential (read from environment variables, never hardcoded) — proves, for real: a new file is uploaded and verified; re-syncing identical content creates no second row (duplicate-safety); modified content is detected and re-uploaded; a rename repoints local state *and* physically relocates the remote object; and a local delete never touches the remote copy. All 8 tests pass; `cargo test` (the full suite) shows zero regressions elsewhere in `inaya-desktop`.
- **Real Windows validation**: this development environment is a genuine Windows 11 machine — every test above, including the end-to-end one, ran as a real compiled Windows binary against a real running server, not a cross-compiled or emulated target.
- Next.js production build compiles cleanly with the new view and nav entry registered.

## Known Limitations / Explicitly Deferred

- **Linux validation was not performed in this pass.** `notify`, `notify-debouncer-full`, and `rusqlite` are all genuinely cross-platform crates (this repo's own `inaya-drive-helper-linux` already proves the same `inaya-drive-core` S3 client works identically on Linux), so there is no known platform-specific blocker — but per the SOW's own explicit instruction not to claim support without real hardware validation (the same standard it sets for macOS), this is stated as **UNVERIFIED on Linux**, not claimed.
- **macOS is out of scope**, per the SOW's own explicit instruction.
- **"Create Secure Link" (SOW §6.9) was not built in this pass.** The reusable primitive (`s3-compat/signedUrl.js`) exists and was confirmed during the audit, but wiring a right-click-equivalent action into a synced file's queue row was deprioritized in favor of a fully tested core sync engine within this session's scope. A future pass can add it as a thin call into the existing signing scheme without inventing anything new.
- **Uploads are whole-file, not resumable byte-range uploads.** A row is only marked `DONE` after a complete, verified PUT; an interrupted upload leaves the row `QUEUED`/`FAILED` and a retry re-uploads the whole file cleanly. This keeps the stored object byte-correct without building a second, resumable-multipart protocol on top of the existing single-PUT S3-compat write path — the same disclosed trade-off Feature 3's large-object handling makes.
- **DirectSync only runs while `inaya-desktop` itself is running** (see the Scope Decision above) — not a true OS-independent background service.
- **Only one destination credential is configured at a time**, shared by every watched folder (each folder can still point at its own bucket/prefix). Multiple simultaneous cloud identities were not required by any concrete use case surfaced during this pass.
