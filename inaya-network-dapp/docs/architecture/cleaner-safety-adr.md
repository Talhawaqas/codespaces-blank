# ADR: Inaya Cleaner — deletion safety model

Status: accepted 2026-10-07. Scope: Inaya Cleaner (Internxt-inspired SOW, Workstream B).
Companion: `docs/security/cleaner-threat-model.md`.

## 1. Decision

Cleaner is a **local-first, trash-not-permanent-delete** desktop utility, shipped inside the existing `inaya-desktop` Tauri application
(not a fourth native app, SOW §6.2, §19.15). It scans the local filesystem only; it never uploads a file inventory, and it never deletes
anything without explicit, per-item user review.

## 2. Local-first boundary

All scanning happens in the Tauri Rust process, on the local machine. The server receives nothing from a scan by default. Only
coarse, aggregate metadata may ever sync (last-scan timestamp, category, bytes-reclaimed bucket, scanner version) — never file paths,
filenames, duplicate groups, or content hashes (§6.15, §9.3, §12.3).

## 3. Scan categories (v1)

| Category | Detection | Default safety |
|---|---|---|
| Temporary files | Platform-specific OS/app temp directories only; never a heuristic "looks temporary" path match | Conservative — explicit directory allowlist per platform, not a pattern guess |
| Duplicate files | Staged: file size → candidate set → full content hash only within same-size groups → group identical content → suggest a keeper, require explicit user choice | Never assumes a duplicate is disposable from bytes alone (§6.4) |

Additional categories (stale app cache, logs, download caches) are deferred until a platform-specific safety audit confirms each one
independently — no category ships "because it was convenient."

## 4. Protected paths

A platform-specific denylist blocks deletion of: OS-critical directories, Inaya's own configuration/key-material directories,
credential stores, the user's home root, mounted Inaya Drive metadata, active backup state, the current DirectSync state database,
application binaries, database files, plus user-added exclusions. The denylist is enforced at the **final deletion primitive**, not
only in the UI layer — a bug in the review screen cannot bypass it (§6.6, §11.5).

## 5. Deletion mechanics

Where the OS provides a trash/recycle-bin API, Cleaner moves content there by default rather than permanently deleting it. Only
categories that are genuinely permanent by nature get a strong, explicit irreversible warning — Cleaner never promises "undo" where the
OS provides no real undo path (§6.10).

## 6. Security

No shell execution is ever constructed from a scanned filename; all filesystem operations use Rust's direct filesystem APIs (`std::fs`),
never shell interpolation. Symlinks are not followed into deletion candidates by default. Filenames are sanitized before UI rendering.
This mirrors the same security discipline `inaya-desktop`'s existing Tauri commands already apply (`verify_trusted_origin` guard,
path validation in DirectSync's folder commands) — see `docs/internxt-feature-reuse-matrix.md`.

## 7. Backup interaction

Cleaner must warn — never silently act — when a user attempts to clean a file inside an actively-backed-up folder: it shows that the
folder is backed up, and distinguishes local deletion from remote backup deletion. A local Cleaner delete **never** mirrors into the
remote backup copy (§5.6, §11.6). This is enforced by checking the existing backup-scope state (`endpoint/backup.js`'s watched-folder
registry) before a cleanup action proceeds, not by a new cross-system delete path.

## 8. What this is not

Not ransomware protection (that's the existing Security Layer / Competitive Expansion ransomware-signal feature — a Cleaner finding is a
local cleanup recommendation, a ransomware finding is a different, separate system, §5.7). Not a RAM/process-killing "optimizer" — no
arbitrary process termination ships in this pass (§6.14, §19.25). Not a hardware-health diagnostic tool.

## 9. Platform scope

Windows first, Linux next, macOS only when real hardware/CI is available for actual verification — never claimed as verified from
source compilation alone (§6.19, §15.3 CLN-010).
