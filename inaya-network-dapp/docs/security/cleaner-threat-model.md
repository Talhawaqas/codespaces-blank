# Threat model: Inaya Cleaner

Companion to `docs/architecture/cleaner-safety-adr.md`. Status: 2026-10-07, pre-implementation.

## Assets

1. User's local files not intended for deletion (the primary asset — Cleaner is a deletion-capable local tool). 2. Inaya's own local
configuration, key material, and active backup/sync state. 3. The integrity of the scan report shown to the user before any deletion.

## Actors

**Malicious or malformed local filename** (crafted to exploit a naive scanner). **Attacker who can write to a watched directory between
scan and cleanup** (race). **A bug in Cleaner itself** treated as an actor, since Cleaner is privileged local software with real deletion
capability (SOW §11.5).

## Threats and mitigations

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Filename constructed to break out via shell interpolation | No shell execution is ever used for file operations; direct Rust filesystem APIs only | code audit + unit test with adversarial filenames |
| T2 | Path traversal via a crafted relative path | All paths normalized and checked against the protected-path denylist before any operation | path-normalization/protected-path tests |
| T3 | Symlink attack: a symlink inside a scan target points at a protected path | Symlinks are not followed into deletion candidates by default | symlink-handling test |
| T4 | Race between scan and delete: file replaced with a different (protected) file between review and cleanup | Final deletion primitive re-checks the protected-path denylist immediately before acting, not only at scan time | file-mutation-during-scan test |
| T5 | Protected-path bypass via the review UI | Denylist enforced at the final deletion primitive, independent of what the UI displayed or allowed selecting | adversarial: direct-call bypass attempt |
| T6 | Cleaner deletes a file inside an active backup scope, silently removing the only copy | Cleaner checks backup-scope state before acting and warns instead of silently acting (ADR §7) | backup-scope-warning test |
| T7 | Local file inventory exfiltrated to the cloud | No server-side file-inventory collection exists; only coarse aggregate metadata (timestamp/category/bytes/version) may ever sync, and only after an explicit privacy-approved feature | code audit: no inventory upload path |
| T8 | Privilege escalation via a crafted scan target (e.g., a path requiring elevated permissions) | Permission errors are handled as a non-fatal, reported result (skipped, with reason) — Cleaner never attempts to escalate privileges to force access | permission-error handling test |
| T9 | Attacker-controlled Cleaner state (e.g., tampered local scan-state file) causes a wrong deletion | Scan state is re-validated against the live filesystem at cleanup time, not trusted blindly from a possibly-stale persisted state | stale-state test |
| T10 | Unicode/malformed filename crashes the scanner or misrenders in the UI | Scanner is robust to malformed filenames and unusual Unicode (SOW §6.18); filenames sanitized before UI rendering | fuzz-style filename test |

## Explicitly out of scope

Cleaner is not a ransomware detector and does not attempt to classify or respond to ransomware behavior — that threat surface belongs to
the existing Security Layer (ADR §8). Multi-user-on-shared-device isolation relies on OS-level user separation where the OS provides it;
Cleaner does not implement its own user-isolation layer.
