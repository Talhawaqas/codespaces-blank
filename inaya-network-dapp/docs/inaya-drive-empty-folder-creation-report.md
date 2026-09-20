# Inaya Drive Empty Folder Creation SOW — Report

Per the SOW's own mandated sequence: **Audit → Reuse → Implement → Test → Integrate → Secure → Prove → Document**.

## Phase 0 — Audit findings

| Concern | Finding | Action |
|---|---|---|
| Wallet-side folder tree | `metadata_folders` is a real, complete, hierarchical, soft-deletable folder system (`folderId`/`owner`/`name`/`parentFolderId`/timestamps/`deletedAt`), already wallet-signature-authenticated via `src/lib/metadata-auth.js` and the five `api/metadata/*-folder` routes | **Reused directly** for the wallet side of the S3-compat layer — an S3 "folder" inside a wallet bucket is just a real nested `metadata_folders` chain rooted at the bucket's own `folderId` |
| Org-side folder tree | No equivalent exists — org buckets are `projects` rows; objects are flat-keyed `org_documents` rows with no folder concept at all | **Genuine gap.** Added one new collection, `s3_folders`, mirroring `metadata_folders`' proven shape (same field names, same soft-delete-orphan-not-cascade semantics) |
| Listing | `listS3Objects` already derives pseudo-folders from object-key prefixes into `commonPrefixes` | Extended (not replaced) to also merge real, non-deleted folder rows for the requested prefix — an empty folder now appears identically to an object-derived one |
| WinFSP Rust client | `create()` hard-rejected `FILE_DIRECTORY_FILE`; `cleanup()` assumed every deletable entry was a file; `rename()` was unimplemented | All three updated; `resolve()`'s existing prefix-listing logic extended to detect a real empty folder via its own parent's `CommonPrefixes` — no new RPC needed |

## What was built

- **`src/lib/s3-compat/store.js`** (org): `s3_folders` collection + `createS3Folder` (auto-vivifies ancestors, rejects a duplicate leaf), `deleteS3Folder` (soft-deletes, orphans child folders to the bucket root — never cascades, matching `metadata_folders`' own proven precedent), `renameS3Folder` (rename and/or move in one op, requires a real destination parent), `getS3FolderInfo`. `listS3Objects` merges live folder rows into `commonPrefixes`.
- **`src/lib/s3-compat/walletStore.js`** (wallet): the same four functions, implemented directly over `metadata_folders` — no new collection.
- **API**: a new `?folder` sub-resource on `/api/s3/[bucket]/[...key]` — `PUT ?folder` (create), `DELETE ?folder` (delete), `POST ?folder&to=<path>` (rename). Explicitly disclosed as an Inaya-specific extension (real S3 has no empty-folder primitive), not sent by third-party S3 clients.
- **Deterministic error codes**: `FolderAlreadyExists` (409), `InvalidFolderName` (400), `NoSuchFolder` (404), `NoSuchParentFolder` (404), added to `xml.js`'s error table and attached to every thrown folder error via a `.code` field, so the API and the Rust client both map failures precisely instead of a generic 500.
- **`inaya-drive-helper/src/s3client.rs`**: `create_folder`/`delete_folder`/`rename_folder`, returning a typed `FolderOpError { status, message }` carrying the real HTTP status.
- **`inaya-drive-helper/src/main.rs`**: `resolve()` now detects a real empty folder via a parent-prefix `CommonPrefixes` lookup; `create()` creates a real folder instead of rejecting `FILE_DIRECTORY_FILE` — **this is what makes Windows Explorer's right-click → New → Folder action durable** instead of the previous hard rejection; `cleanup()` branches file vs. folder deletion; a new `rename()` method handles folder rename/move (file rename has no backing primitive yet and is rejected with `STATUS_NOT_SUPPORTED`, disclosed in-code rather than silently attempted).

## Storage/DePIN impact — verified by construction and by test

An empty folder never touches `org_documents`/`metadata_files`, `InayaKernel.disperseAndSlice`, any pinning provider, `backupEngine`, Object Lock/Versioning/Lifecycle logic, or Proof-of-Storage — all of that machinery is object-row-scoped, and a folder row has no relationship to any object row by construction. Verified directly by test: "an empty folder does NOT create any org_documents row."

## Testing

- **`test/s3-compat-empty-folder.test.mjs`** — 17 new tests against the real database, both org and wallet sides: root/nested creation, duplicate/invalid-name rejection, no-side-effect-on-object-storage, files placed inside a folder work normally, rename (including rejecting a nonexistent destination parent), delete-orphans-not-cascades, delete never touches a same-prefix object, idempotent delete. **All 17 passing.**
- **Live HTTP verification** against the real running dev server, using a from-scratch AWS4-HMAC-SHA256 client (the same technique used to verify SigV4/GOOG4 in earlier SOWs this session) exercising the exact request/response cycle the Rust Drive client performs: create bucket → create empty folder → confirm it appears in `ListObjectsV2` `CommonPrefixes` → reject duplicate → nested folder → rename → confirm old name gone / new name present → delete → confirm gone → real file upload inside the folder still works and lists as `Contents`, not folder metadata. **12/12 checks passed.**
- **Regression**: `test/s3-compat-store.test.mjs`, `test/s3-compat-sigv4.test.mjs`, `test/s3-compat-capabilities.test.mjs` re-run clean after this change.
- **Rust build**: `cargo build` — clean, zero warnings.

## Live Drive (WinFSP mount) verification — honest limitation

The SOW's own strongest test (kill the helper, restart it, confirm the empty folder survives) requires mounting a real drive letter via the WinFSP kernel driver. In this development sandbox, that mount attempt fails immediately with `ACCESS_DENIED` before any of this code's own logic runs (confirmed via `fsptool`, the Windows Event Log, and testing that the same executable launches and parses arguments normally) — consistent with `winfsp.sys` never having been loaded on this machine, which requires an admin-elevated first load. This is a pre-existing environment/privilege constraint, not a regression from this change: nothing in `create()`/`cleanup()`/`resolve()`/`rename()` runs before `FileSystemHost::mount()` succeeds.

What **is** proven end-to-end: the exact HTTP contract the Rust client's `create_folder`/`delete_folder`/`rename_folder`/`list_objects` calls depend on, verified live above. What remains unverified in this sandbox specifically: the WinFSP mount step and the literal Explorer right-click interaction. To complete that proof, run (from an elevated PowerShell, or on a machine where `winfsp.sys` is already loaded):

```
inaya-drive-helper.exe --endpoint http://localhost:3000/api/s3 --access-key-id <key> --secret-access-key <secret> --drive I:
```

then right-click inside `I:\<bucket>\` in Explorer → New → Folder.

## Explicit non-goals honored

No redesign of Inaya Drive or the existing folder systems; no second metadata database (org side reuses one new collection shaped identically to the proven wallet-side one; wallet side adds zero new collections); no new authentication system; no new audit system (org folder mutations log through the existing `logOrgActivity`); no changes to encryption/sharding/redundancy/Proof-of-Storage; no macOS/Linux support claimed (Windows-only, matching the existing Object Mount disclosure); no local metadata caching added; no Business Workspace folder redesign; no fake `.folder`/`.keep` placeholder objects — folders are real, durable metadata rows, never fake object placeholders; file rename is explicitly out of scope this pass (disclosed, not silently missing).
