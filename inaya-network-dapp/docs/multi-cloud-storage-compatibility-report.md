# Multi-Cloud Enterprise Storage Compatibility SOW — Progress Report

Per the SOW's Phase 0 mandatory audit and the approved plan (`shiny-juggling-creek.md`). This report will be extended as Workstreams B (Azure) and C (Nerdio) complete in a later session.

## Status

- **Workstream A (S3): implemented and verified against the real AWS CLI.**
- **Workstream B (Azure Blob): not started.**
- **Workstream C (Nerdio): not started** (per the SOW's own §6 and the plan, this is a documentation deliverable once B exists, not new code).

## Phase 0 audit — what already existed vs. what was genuinely built

See `shiny-juggling-creek.md`'s own Phase 0 table for the full citation-backed inventory. Summary: client-side encryption/sharding (`disperseAndSlice`/`reconstructAndDecrypt`), redundant pinning (`backupEngine.js`, `pinningProviders/*` — including a real, already-working outbound S3 client in `filebase.js`), and a real 3-level org→department→project document hierarchy (`org_documents`) were all reused as-is. AWS SigV4 request signing, S3-compatible credentials, and the entire inbound S3 REST surface were genuinely absent and are what this pass built.

## The architecture decision (approved)

Objects written through the S3/Azure compatibility layer are encrypted server-side with an org- or wallet-owned passphrase (Option A from the plan), not the zero-knowledge browser-only key model the rest of Inaya uses — because S3/Azure client tools don't perform Inaya's client-side encryption step themselves. This is disclosed plainly in both UI surfaces (`S3CompatView.js`, `S3CompatSection.js`) and here, not implied to be equivalent to the wallet-side guarantee. The key-custody protections (envelope encryption via `S3_COMPAT_ENCRYPTION_KEY`, per-owner scoping, audit logging, isolation from the zero-knowledge path) are exactly as described in the approved plan.

**Scope expansion during implementation, per your explicit direction mid-session:** the compatibility layer covers **both** ownership models Inaya already has — an org's Business Workspace documents (`org_documents`) **and** a wallet's personal vault (`metadata_files`/`metadata_folders`) — with credential management surfaced in **both** Business Workspace and the dApp, so neither surface requires visiting the other to use S3-compatible storage.

## Files added

### Shared library (`src/lib/s3-compat/`)
- `crypto.js` — envelope-wraps each owner's compatibility-layer passphrase, same AES-256-GCM shape as the existing `mfaCrypto.js` (new master key: `S3_COMPAT_ENCRYPTION_KEY`, `.env.local`-only, never committed).
- `credentials.js` — issues/lists/revokes S3 credentials for either an org or a wallet owner; the raw secret is shown exactly once, matching `api-keys.js`'s discipline.
- `sigv4.js` — real AWS Signature Version 4 request verification (canonical request → string-to-sign → derived signing key → HMAC), the one genuinely new cryptographic primitive in this SOW.
- `auth.js` — ties credential resolution to signature verification for every S3 route.
- `store.js` — the org-side translation layer: bucket = a project under a hidden `S3/Azure Compatible Storage (System)` department; key = the document's `filename` (S3 keys are flat strings; no real folder hierarchy needed). Real encrypt→shard→pin→register pipeline, byte-range GET (server-side reconstruct-then-slice — AES-GCM's auth tag covers the whole ciphertext, so there is no partial-decrypt path), and multipart upload (buffer-then-assemble through the same single-object pipeline).
- `walletStore.js` — the wallet-side twin, over `metadata_files`/`metadata_folders`, kept as a genuinely separate implementation rather than a branch inside `store.js`, mirroring this codebase's own existing split between the two ownership models.
- `xml.js` — minimal S3-shaped XML response/error builders.

### API routes
- `src/app/api/s3/route.js`, `[bucket]/route.js`, `[bucket]/[...key]/route.js` — the actual S3 REST surface (ListBuckets, CreateBucket, ListObjectsV2, PutObject, GetObject with Range support, HeadObject, DeleteObject, CreateMultipartUpload/UploadPart/CompleteMultipartUpload/AbortMultipartUpload). Dispatches to `store.js` or `walletStore.js` based on which ownership type the resolved credential belongs to.
- `src/app/api/orgs/s3-compat/credentials/route.js` + `[accessKeyId]/route.js` — Business Workspace's own session-authenticated credential management (owner/admin only, same gate as `api-keys.js`).
- `src/app/api/wallet/s3-compat/credentials/route.js` + `[accessKeyId]/route.js` — the dApp's wallet-signature-authenticated equivalent (`verifyMetadataAuth`, same convention as every other metadata mutation).

### UI
- `src/components/business/S3CompatView.js` — Business Workspace's "S3-Compatible Storage" settings screen (new nav entry, `s3Compat`).
- `src/components/S3CompatSection.js` — the dApp's equivalent tab (new nav entry, "S3 Storage"), wallet-signature gated.

### Tests
- `test/s3-compat-sigv4.test.mjs` — 9 pure unit tests for the SigV4 algorithm itself (no DB/network): correct-signature acceptance, wrong-secret rejection, tampered-path/body rejection, replay-window rejection, malformed-header handling, UNSIGNED-PAYLOAD support. **9/9 pass.**
- `test/s3-compat-store.test.mjs` — 9 integration tests against the real database and real pinning provider: credential issue/resolve/revoke, cross-org isolation, real encrypt→shard→pin→reconstruct→decrypt round-trip byte-identity, overwrite semantics, idempotent delete, and a regression test for the fileHash bug below. **9/9 pass** (confirmed via the full test-runner output after the process was killed post-completion — see note below).

**A note on the test run itself:** `node --test` buffers all output until process exit, and this run's process didn't exit on its own afterward (an idle MongoDB connection handle keeping the event loop alive — the existing test files in this repo have the same characteristic; none of them call `process.exit()` either). I killed the process after ~10 minutes of it sitting idle post-completion and confirmed via the flushed output that all 9 tests had genuinely passed, with real per-test timings (0.8s–12s each, consistent with real network calls to the pinning provider) — not a hang in the code being tested.

## A real bug found and fixed during this pass

`putS3Object()` computed a `fileHash` value but never actually included it in the inserted `org_documents` document. Since `org_documents` has a **unique index on `fileHash`** (from the existing wallet/treasury upload path, where re-uploading identical bytes is deliberately rejected as a duplicate), every object written through the S3-compat layer was silently getting `fileHash: undefined` → stored as `null` — and the *second* such object always failed with a MongoDB duplicate-key error, since a unique index only tolerates one `null`. Caught by testing the required multipart-upload flow with the real AWS CLI, not by code review. Fixed by computing `fileHash` as a real SHA-256 of the actual uploaded bytes, salted with the new document's own `_id` — deliberately not a pure content hash, since S3 must allow uploading identical bytes to a different key (or re-uploading a key unchanged), which the existing collection's dedup-oriented unique index was never designed to allow. Covered by a permanent regression test (`s3-compat-store.test.mjs`'s "every fileHash written is unique" case).

## Real-tool testing (AWS CLI, against the local dev server via `--endpoint-url`)

No AWS account needed — every AWS tool supports a custom endpoint override, the same technique MinIO and every other S3-compatible product is tested with. All commands run against `http://localhost:3000/api/s3` with a real, freshly-issued Inaya credential.

| Operation | Command | Result |
|---|---|---|
| List buckets (empty) | `aws s3 ls` | ✅ empty, as expected |
| Create bucket | `aws s3 mb s3://test-bucket` | ✅ `make_bucket: test-bucket` |
| Upload | `aws s3 cp testfile.txt s3://test-bucket/` | ✅ |
| List objects | `aws s3 ls s3://test-bucket/` | ✅ correct name/size/date |
| Download | `aws s3 cp s3://test-bucket/testfile.txt downloaded.txt` | ✅ **byte-identical** (`diff` confirmed) |
| Byte-range GET | `aws s3api get-object --range bytes=6-10` | ✅ returned exactly `"from "` (5 bytes) with correct `ContentRange`/`ContentLength` |
| Metadata | `aws s3api head-object` | ✅ correct `ContentType`, `ContentLength`, `ETag`, `AcceptRanges` |
| Multipart upload (create/upload-part ×2/complete) | `aws s3api create-multipart-upload` / `upload-part` / `complete-multipart-upload` | ✅ assembled object downloaded byte-identical to the two parts concatenated (first attempt caught the fileHash bug above; second attempt after the fix succeeded cleanly) |
| Delete | `aws s3 rm` ×2 | ✅ |
| List after delete | `aws s3 ls` | ✅ empty |
| **Cross-org isolation (SECURITY)** | A second org's credential calling `aws s3 ls` | ✅ returned **zero** buckets — never saw the first org's `test-bucket` |
| **Wrong secret (SECURITY)** | `aws s3 ls` with a tampered `AWS_SECRET_ACCESS_KEY` | ✅ rejected: `SignatureDoesNotMatch` |
| **Nonexistent access key (SECURITY)** | `aws s3 ls` with a made-up access key ID | ✅ rejected: `InvalidAccessKeyId` |
| **Revoked credential (SECURITY)** | Revoke a credential, then reuse it | ✅ rejected: `InvalidAccessKeyId` |
| Same org, second credential | A different credential for the *same* org | ✅ correctly saw the same org's bucket (credentials are many-to-one with an org, not a 1:1 identity) |

**rclone**: not installed in this environment; not tested. Stated honestly rather than claimed.

## Security review

- Every S3 credential resolves to exactly one owner (org or wallet) at issuance time and can never be redirected to a different one — verified both by code inspection (`resolveS3Credential` reads the owner from the credential's own stored record, never from anything the request supplies) and by the live cross-org isolation test above.
- The org-side credential-management routes require `canManageOrg` (owner/admin), same gate as `api-keys.js`.
- The wallet-side routes require a real wallet signature (`verifyMetadataAuth`), same convention as every other metadata mutation.
- Every S3 object write is logged to the org's real audit chain (`logOrgActivity`) on the org side.
- No client-side or S3-credential-side permission check was weakened — an S3 credential carries the same synthetic owner-level authority `api-keys.js`'s bearer tokens already carry, nothing broader.
- Client-side encryption, sharding, DePIN pinning, and org-isolation are all fully intact and reused unmodified for every other part of the app; only the new compatibility-layer objects use the disclosed server-managed key model (see the architecture decision above).

## Disclosed, deliberate scoping limits (not silently different from S3 itself)

- **No synchronous on-chain registration per object.** The existing wallet/treasury upload path registers each file on-chain as a real confirmed transaction — appropriate for a human uploading one document, but it would make a bulk `aws s3 sync` of many files take minutes and burn testnet gas per object. Integrity is still fully real (SHA-256 hash, AES-256-GCM encryption, binary sharding, redundant pinning) without it. Batched/async on-chain anchoring is a natural follow-up, not built in this pass.
- **Byte-range GET decrypts the whole object server-side, then slices.** AES-GCM's authentication tag covers the entire ciphertext as one unit — there is no partial-decrypt path in the underlying crypto, so this is the only correct way to serve a real range without weakening the integrity check.
- **Multipart parts are capped at 8MB each**, matching the existing `/api/upload` route's own shard-size cap elsewhere in this codebase — not a new, arbitrarily different limit.
- **Presigned-URL (query-string) SigV4 signing is not implemented** — only header-based `Authorization: AWS4-HMAC-SHA256 ...`, which is what the AWS CLI and every SDK use by default for every operation this SOW's Definition of Done requires (`aws s3 presign` specifically would not work).
- **rclone was not tested** (not installed in this environment).

## Environment / dependency changes

New env var: `S3_COMPAT_ENCRYPTION_KEY` (`.env.local`, 32 random bytes base64, generated for this session — must be rotated for any real deployment). No new npm dependencies — `@aws-sdk/client-s3` was already present (used by `filebase.js`); everything else uses Node's built-in `crypto`.

## Next session (Workstream B: Azure Blob, then C: Nerdio)

Per the approved plan's sequencing: Azure reuses this pass's translation layer and key-custody system directly; the new work is Azure's own header/response conventions, determining which blob type (block/page/append) is actually applicable to Inaya's model, and wiring the existing Entra ID app registration (`integrationProviders/microsoft.js`) as an identity-federation option. Nerdio is a documentation deliverable once B exists.
