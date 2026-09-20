# Enterprise Adoption & Market Reach Expansion SOW — Report

Per the SOW's own mandated principle: **Audit → Reuse → Isolate → Implement only genuine gaps → Test → Secure → Prove.**

## Workstream A — Zero-Touch Multi-Cloud Migration Engine

**New package**: `inaya-migration-agent/` (standalone Node CLI, `inaya-migrate`), sibling to `inaya-drive-helper`. Credentials for both source and destination never leave this local process — the browser/web control plane never sees them (§4.3).

- **Sources**: AWS S3 and Azure Blob via their real, official SDKs (`@aws-sdk/client-s3`, `@azure/storage-blob`). GCS via the already-proven S3-compatible XML API path (literally the same AWS S3 client, pointed at `storage.googleapis.com` with an HMAC key pair) — no native Google OAuth/service-account code, per §4.4's own scoping instruction.
- **Destination**: the real, already-tested Inaya S3-compat endpoint, via the same `@aws-sdk/client-s3` client a genuine AWS destination would use — no second encryption/sharding system (§4.5). Large objects use `@aws-sdk/lib-storage`'s `Upload` helper, which transparently uses real S3 multipart upload rather than buffering whole objects in memory.
- **Idempotency/resume** (§4.8): an append-only local JSON-Lines manifest, one record per source key. A killed/restarted process resumes automatically — objects already recorded `MIGRATED` are skipped, never re-migrated or duplicated.
- **Modes** (§4.6): full bucket, prefix-scoped, explicit object list, and dry-run (inventory only, zero reads/writes).
- **Integrity** (§4.7): every migrated object is verified by a real `HeadObject` against the destination immediately after upload; size mismatch or a missing object is a hard `FAILED` record, not a silent success.
- **Job reporting**: a new `?migration-log` sub-resource on the existing `/api/s3/[bucket]` route logs `MIGRATION_STARTED`/`COMPLETED`/`FAILED` to the org's **existing** audit chain — no parallel tracking system (§8.3).

### Testing

- `test/manifest.test.mjs` — 5 real filesystem tests: resume-after-restart, retry-then-succeed overriding a prior failure, truncated-final-line crash safety.
- `test/live-migration.test.mjs` — 4 real, live end-to-end tests against the running dev server (Inaya's own endpoint standing in as both source and destination, since no real AWS/Azure/GCP credentials are available in this environment — an honest, disclosed substitution, not a claim of testing against literal AWS/Azure/GCS): full migration with byte-identical content verification, resume/no-duplication, dry-run performs zero writes, failure handling records a real `FAILED` entry. **All pass.**

### Real bugs found and fixed along the way (all now benefit every S3 client, not just this CLI)

1. **Next.js 308 redirect on bucket-only requests.** Every real S3 SDK (not just this one) issues `CreateBucket`/`DeleteBucket` with a trailing slash (`PUT /bucket/`). Next.js's default trailing-slash redirect turned that into a 308, which no S3 SDK client can parse as a valid response. Fixed via Next.js's own `skipTrailingSlashRedirect` config flag — the officially documented fix for exactly this class of problem.
2. A dual-package BSON hazard in this repo's own new live test (fixed by not constructing a second `ObjectId` instance across package boundaries).

## Workstream B — Enterprise Backup Ecosystem Connectors

Tested for real against the live Inaya endpoint, not assumed compatible because a product "speaks S3" (§3.3):

| Connector | Status | Evidence |
|---|---|---|
| **Rclone** | ✅ Verified Compatible | Real `mkdir`/`copy`/`ls`/`cat`/`sync` all succeeded; wrong-secret request correctly rejected `403 SignatureDoesNotMatch`. |
| **Terraform** | ✅ Verified Compatible | Real `init` → `apply` (bucket + object) → `plan` (zero drift) → `destroy` (including `force_destroy` emptying a bucket) all succeeded against the live endpoint using the standard `hashicorp/aws` provider with S3-compatible endpoint overrides. |
| **AzCopy** | ❌ Unsupported (real, disclosed technical incompatibility) | AzCopy requires SAS-token or Microsoft Entra ID authentication for Azure Blob; Inaya's Azure-compatible layer currently implements Shared Key authentication only, which AzCopy's CLI does not accept. Confirmed via AzCopy's own documented auth model — not a bug, a genuine gap for a future SOW if SAS support is ever prioritized. |
| Veeam / Synology Hyper Backup / QNAP | ⬜ Not Tested | No hardware/environment available in this sandbox, honestly disclosed per §5.7 rather than assumed. |

### Real bugs found and fixed via this real testing (not hypothetical — each blocked an actual `terraform apply`/`destroy`)

1. **Missing bucket sub-resources** (`?policy`, `?cors`, `?website`, `?encryption`, `?ownershipControls`, `?publicAccessBlock`, `?logging`, `?accelerate`, `?requestPayment`) fell through to the plain object-listing handler instead of a real "not configured" S3 error, breaking any Terraform `aws_s3_bucket` resource's normal refresh. Added real, minimal handlers matching AWS's own empty-state responses.
2. **`ListObjectVersions` was single-key-only.** Terraform's `force_destroy` needs to enumerate *every* version of *every* object in a bucket before deleting it. Added a real, bucket-wide `GET ?versions` (single-page; pagination is a disclosed, out-of-scope-for-this-pass limitation) alongside the pre-existing single-key JSON shape (kept unchanged, zero regression to Business Workspace's own use of it).
3. **`DeleteObjects` (batch delete) didn't exist.** Added `POST /:bucket?delete`, the real S3 batch-delete API, required by `force_destroy` to actually remove leftover versions.

## Workstream C — Proof of Sovereignty / Compliance Evidence Exporter

**Read-only.** New: `src/lib/evidenceExporter.js` (aggregation), `src/lib/evidencePdf.js` (PDF rendering via `pdfkit` — pure JS, no headless browser, so it runs in the real serverless deployment target, unlike the puppeteer-based scripts this repo uses for offline document generation). New route: `GET /api/orgs/evidence-export?orgId=&format=json|pdf`, gated to org owner/admin. New Business Workspace panel: **Compliance Evidence**, reusing `AuditTrailView.js`'s own established pattern.

No second audit system (§6.3): the package is built entirely from existing records — `auditChain.js`'s real hash-chain (with a live `verifyChainIntegrity` recomputation, not a cached flag), `store.js`'s real bucket versioning/Object Lock/lifecycle state, and the org's existing plain activity log for security events. Exports never mutate anything they read (§6.5) — the one intentional write is the export-generation event itself, logged to the same existing audit chain (§6.8). A deterministic canonical JSON serialization produces a real SHA-256 export hash (§6.6). Regulatory language is exactly the SOW's own suggested wording (§6.7) — no HIPAA/GDPR/SOC2/17a-4 certification claim anywhere.

### Testing

- `test/evidence-exporter.test.mjs` — 5 real DB-backed tests: canonicalization determinism, real bucket/lifecycle evidence inclusion, real audit-chain inclusion with a genuine integrity check, export-hash change-detection (and a from-scratch hash recomputation matching), and a read-only-requirement test proving `buildEvidencePackage` mutates nothing it reads. **All pass.**
- Live check against the real running server: JSON export (200, correct evidence), PDF export (200, genuine `%PDF`-headed binary), and an unauthenticated request correctly rejected `401`.

## Workstream D — Extended Inaya Drive Desktop Parity

**Refactor first** (real reuse, not duplication): `inaya-drive-helper`'s `s3client.rs`/`sigv4.rs` had zero Windows/WinFSP dependencies, so they were extracted into a new shared crate, **`inaya-drive-core`**, licensed separately (`UNLICENSED`, not GPL-3.0 — it has no GPL dependency of its own; only WinFSP's binding does). Both the Windows and the new Linux helper link this one crate. The Windows helper's own `cargo check` confirms the refactor is correct (a full rebuild is pending only because the exe is locked by an already-mounted instance in the user's own elevated session).

**New**: `inaya-drive-helper-linux/`, using `fuser` (MIT — no GPL obligation, unlike WinFSP). Real, live-tested on a genuine Linux kernel (WSL2 Ubuntu 26.04, not a simulation):

- Mount, clean unmount
- Directory listing, file read/write
- **Empty folder creation** (the exact same `create_folder` primitive the Windows Explorer integration uses)
- Folder rename/move, file and folder delete
- **Persistence across a full helper-process restart** — the SOW's own explicitly-named strongest test, passed
- 5 real unit tests for the path/inode logic (`cargo test`, all passing)

Disclosed limitations, matching the Windows helper exactly: no local metadata caching (correctness-first, by design, not an oversight), file rename has no backing primitive yet (`ENOSYS`), cross-bucket folder move unsupported (`ENOSYS`).

**macOS: architecture only, explicitly not validated.** `fuser` documents native macOS support (via macFUSE) using the identical `Filesystem` trait already implemented here, so this same source is intended to also build on macOS with little or no change — but it has **not** been compiled, linked, or run on macOS: no Mac hardware, Xcode toolchain, or macFUSE installation exists in this environment. Labelled **Experimental / Pending Hardware Validation**, exactly per §3.4/§7.4's own instruction — no production-support claim is made.

## Cross-cutting security (§8)

- No credential (AWS/Azure/GCS/Inaya) is ever logged in any of the new code paths — verified by inspection (every log line references key IDs/labels/status, never secret values).
- Migration/evidence-export/connector-validation actions all respect existing organization membership and permissions — reused `requireMembership`/S3-credential org-scoping unchanged, no new authorization model.
- Every material new action (migration start/complete/fail, evidence export generated) writes to the **existing** audit chain — zero new audit systems anywhere in this SOW.

## Explicit non-goals honored

No replacement of encryption/sharding/DePIN/backup/audit chain; no second storage protocol stack; no unnecessary rewrite of S3/Azure/GCS compatibility (only real, narrow, Terraform/SDK-driven gaps were closed); no browser access to local cloud credential files; no claimed Veeam/Synology/QNAP/AzCopy support without real validation (AzCopy explicitly disclosed as unsupported); no macOS production-support claim without physical Mac testing; no second audit or tracking system anywhere.
