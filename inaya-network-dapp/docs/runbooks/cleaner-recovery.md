# Runbook: Inaya Cleaner recovery

Companion to `docs/architecture/cleaner-safety-adr.md`. What to do when a Cleaner cleanup removed
something that was actually wanted.

## If a file was moved to the recycle bin by mistake

Cleaner moves files to the operating system's own trash/recycle bin by default (ADR §5) — it does
not permanently delete them. Recovery is the normal OS recovery path, not an Inaya-specific one:

- **Windows**: open the Recycle Bin, find the file, right-click → Restore.
- **Linux**: depends on the desktop environment's trash location (commonly `~/.local/share/Trash/files`);
  most file managers expose a Trash/Deleted view with a restore action.

There is no Inaya-side "undo" command, because none is needed — the OS trash already is the undo
mechanism. The UI tells the user this plainly before cleanup (ADR §5, §10).

## If a protected category was somehow proposed for cleanup

This should not happen — `protected_paths()`/`is_protected()` run both at scan time (so a
protected path is never shown as a candidate at all) and again inside `cleanup_selected()` right
before the delete happens (so even a stale or tampered selection is refused). If it's observed
in practice:

1. Capture the exact path and which protected category it should have matched (home root, OS
   directory, Inaya app-data dir, DirectSync state file, or a user exclusion).
2. Check `cleaner.rs`'s `protected_paths()` for that platform — a path may be missing from the
   denylist rather than the enforcement itself being broken.
3. File it as a real defect, not a one-off exception — the fix belongs in the denylist/detector,
   never a manual override of a specific user's cleanup run.

## If duplicate detection grouped two files that were not actually identical

This would mean the content-hash comparison itself is wrong, which is a serious defect (the
grouping logic groups only files sharing an exact SHA-256 hash — see `scan_duplicates()`). Treat
any report of this as a P0 bug: stop recommending Cleaner's duplicate category for any organization
until reproduced and fixed, and check for a hash-truncation or encoding bug before anything else.

## If a Cleaner scan appears to hang or use excessive CPU/memory

Cleaner bounds its own work (`max_candidates` on temp scans, `MAX_HASH_CANDIDATES_PER_GROUP` on
duplicate hashing, `max_depth` on directory traversal) specifically so one pathological directory
tree cannot make a scan unbounded. If a real hang is observed:

1. Note the directory being scanned and its approximate file count.
2. Check whether it's a legitimate very-large directory (raise the relevant bound deliberately) or
   a genuine bug (e.g. a symlink cycle walkdir's own cycle detection didn't catch, or a very deep
   nested structure past `max_depth` that's silently truncating results the user expected to see).
3. Cleaner's scan is read-only until the user explicitly confirms cleanup, so a hung/interrupted
   scan is always safe to simply close the app and retry — nothing is left in a half-deleted state.

## Disabling Cleaner for an organization or device

Per the ADR, Cleaner is independently disableable from the rest of the desktop app (Drive, Sync,
Backup, Meet, Secure Chat) without affecting any of them — it has its own two Tauri commands
(`cleaner_scan`, `cleaner_cleanup`) and no other feature calls into `cleaner.rs`. Like DirectSync
(its closest precedent — also a native-only desktop capability with no org-wide data exposure to
gate), it is not behind a `FEATURE_*` flag: the web-side feature-flag system exists to gate
server routes, and Cleaner makes no server call at all to gate. To disable it, remove its nav
entry from `business/page.js`'s `NAV_ITEMS` and drop the `CleanerView` render branch, or (a
stronger kill-switch, requiring a new desktop release) remove the `allow-cleaner-scan`/
`allow-cleaner-cleanup` grants from `capabilities/default.json`.
