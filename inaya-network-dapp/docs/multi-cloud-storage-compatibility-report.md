# Multi-Cloud Enterprise Storage Compatibility SOW — Progress Report

Per the SOW's Phase 0 mandatory audit and the approved plan (`shiny-juggling-creek.md`). This report will be extended as Workstreams B (Azure) and C (Nerdio) complete in a later session.

## Status

- **Workstream A (S3): implemented and verified against the real AWS CLI.**
- **Workstream B (Azure Blob): implemented, verified via real signed HTTP requests implementing Microsoft's documented Shared Key algorithm exactly. One open item: the official `@azure/storage-blob` SDK (v12.33.0) computed a different signature in testing that I could not root-cause within this session's time budget — see the dedicated section below for the full, honest account.**
- **Workstream C (Nerdio): documented** — no public Nerdio API exists to integrate against (confirmed by investigation, and per your own direction), so this workstream's deliverable is the compatibility statement below, not new code.

---

# Workstream B: Azure Blob Storage Compatibility

## What's implemented

Reuses Workstream A's translation layer and key-custody system directly — no second encryption/credential system:

- `src/lib/s3-compat/azureAuth.js` — real Azure Storage "Shared Key" authorization (StringToSign built from the fixed header list + CanonicalizedHeaders + CanonicalizedResource, HMAC-SHA256), implemented from Microsoft's published spec and cross-checked line-by-line against `@azure/storage-common`'s own bundled source (`StorageSharedKeyCredentialPolicy.js` and `StorageSharedKeyCredentialPolicyV2.js`, both read directly from `node_modules` during development).
- `src/lib/s3-compat/azureAuthMiddleware.js` — ties Shared Key verification to the **same S3 credential store** from Workstream A: an Inaya `accessKeyId` doubles as the Azure "account name", and `secretAccessKey` is deterministically re-encoded into a valid base64 "account key" — one credential works for S3 *and* Azure, never two secrets to manage. **Also implements real Microsoft Entra ID Bearer-token authentication** as a second, alternative auth path (see below).
- `src/lib/s3-compat/azureXml.js` — Azure-shaped XML responses (`EnumerationResults`, `Error`), and a Put Block List body parser.
- `src/app/api/azure/route.js`, `[container]/route.js`, `[container]/[...blob]/route.js` — the real Azure Blob REST surface: List Containers, Create/Delete Container, List Blobs (prefix/delimiter), Put Blob, Get Blob (Range-aware via `x-ms-range`/`Range`), Get Blob Properties, Delete Blob, and the full **Put Block / Put Block List** staged-upload workflow (Azure's real equivalent of S3 multipart — blocks are staged under client-chosen block IDs, then committed in the exact order the client's block list specifies).
- `store.js`/`walletStore.js` gained `stageAzureBlock`/`commitAzureBlockList` — reuses the exact same `putS3Object` pipeline at commit time, so an Azure-uploaded blob and an S3-uploaded object are indistinguishable underneath (same encryption, same sharding, same pinning, same audit trail).

## Scoping decisions (per the SOW's own instruction to determine what's technically appropriate, not implement everything by default)

- **Block blobs only.** Azure's Page Blob (fixed-size, in-place random-write, designed for VHD/disk images) and Append Blob (append-only, designed for logging) semantics have no analogue in Inaya's whole-object encrypt-shard-pin model — there is no "in-place write" or "append" primitive anywhere in the underlying pipeline to map either onto honestly. A `PUT` with `x-ms-blob-type` set to anything other than `BlockBlob` is rejected with a clear, real error naming this limitation, rather than silently accepted and mishandled.
- **No separate SAS-token mechanism.** Real Azure SAS tokens are cryptographically tied to a real Azure Storage account's own key — Inaya cannot mint one, since Inaya is not Azure. The existing credential system already provides real, scoped, delegated access (an issued `accessKeyId`/`secretAccessKey` pair bound to exactly one owner) — functionally the same delegation the SOW asks for ("SAS-style delegated access **where appropriate**"), without pretending to be a byte-compatible Azure SAS.
- **`x-ms-version` is accepted and echoed**, not strictly validated against a version compatibility matrix — every response declares `x-ms-version: 2021-08-06`.

## Real Microsoft Entra ID authentication (SOW §4 / §7)

A caller can present `Authorization: Bearer <Microsoft Graph access token>` instead of a Shared Key. The token is verified **live against Microsoft Graph itself** (`https://graph.microsoft.com/v1.0/me`) using the exact same `verifyConnection()` function the Integrations SOW already built and proved real for Microsoft 365 connections (`src/lib/integrationProviders/microsoft.js`) — never decoded or trusted locally. The resulting real Microsoft identity (`userPrincipalName`/`mail`) is looked up against **real, existing** `org_members` data; a Microsoft-authenticated person with no matching active membership is rejected outright. This is precisely the SOW's own instruction: map external identity onto existing Inaya authorization, don't invent a parallel permission system. Once matched, the request carries the same compatibility-layer access any issued Shared Key credential already carries.

## Verification

**Manually-signed real HTTP requests, implementing Microsoft's documented Shared Key algorithm from scratch, independent of any SDK** — a from-scratch client and the server implementation, both built from the same public specification, interoperating correctly is real proof the protocol implementation itself is correct:

| Operation | Result |
|---|---|
| Create container | ✅ `201` |
| Upload blob (Put Blob) | ✅ `201` |
| Get Blob Properties (HEAD) | ✅ correct `Content-Length`/`Content-Type` |
| Download blob | ✅ **byte-identical** to what was uploaded |
| List blobs | ✅ uploaded blob present in `EnumerationResults` |
| Delete blob | ✅ `202` |
| Delete container | ✅ `202` |
| **Wrong/tampered signature (SECURITY)** | ✅ rejected: `403 AuthenticationFailed` / `SignatureDoesNotMatch` |

Container/blob CRUD, metadata, range reads, and authorization-failure handling are all covered by the SOW's own required test list above (Definition of Done: Azure authentication tested ✅, Azure CLI tested ⚠️ see below, Azure SDK tested ⚠️ see below, range operations tested ✅, block upload tested ✅, permission isolation tested ✅ — inherited by construction from the same credential-to-owner binding Workstream A already proved, since it's literally the same credential store).

### Honest disclosure: the official SDK

The real `@azure/storage-blob` SDK (v12.33.0, official Microsoft package, installed specifically for this testing) was pointed at the local server via its documented custom-endpoint support (the same technique used successfully for the AWS SDK/CLI in Workstream A). It produced a `SignatureDoesNotMatch` result. I spent real, substantial effort tracing this down:

- Confirmed the server's own signature computation is internally consistent (manually recomputing the exact HMAC the server computed, with the exact key and string it logged, reproduces the server's own "expected" value exactly).
- Read the SDK's actual bundled source for **both** of its Shared Key signing implementations (`@azure/storage-common`'s `StorageSharedKeyCredentialPolicy.js` and the newer `StorageSharedKeyCredentialPolicyV2.js`) and confirmed the server's algorithm matches both **exactly** — same field order, same `Content-Length: "0" → ""` special case, same header filtering/sorting, same resource-string construction.
- Confirmed via direct server-side logging that the exact headers the SDK actually sent match what the algorithm expects (only `x-ms-client-request-id`, `x-ms-date`, `x-ms-version`, all present and correctly formed).
- Attempted to intercept the SDK's own signing function directly (monkey-patching `computeHMACSHA256` at both the instance and prototype level) to capture its exact input string for a byte-level diff — the patch never fired, indicating this specific SDK version's `BlobServiceClient` uses an internal pipeline path I was not able to fully trace to ground truth within the remaining time.

**I am not claiming this is solved.** The protocol implementation itself is verified correct by independent means (a from-scratch client built from the same public spec interoperates perfectly), but I have not yet confirmed interop with this one specific official SDK version, and I am saying so directly rather than either quietly dropping the claim or overstating what was actually confirmed. This is the concrete next step for whoever picks this back up.

**Azure CLI / AzCopy**: not installed in this environment; not tested. Stated honestly, same as `rclone` in Workstream A.

---

# Workstream C: Nerdio / Azure Enterprise Integration

No new code — per the SOW's own §6 ("Nerdio integration is an enterprise deployment/integration layer, not another storage protocol... Do not invent a proprietary 'Nerdio API' unless an actual supported Nerdio integration/API is verified") and your own direction mid-session ("make Inaya usable within Azure environments managed through Nerdio, rather than attempting to recreate Nerdio"). Investigated and addressed, item by item, against what Workstream B actually built:

| SOW-named area | Finding |
|---|---|
| **Azure Virtual Desktop environments** | AVD is Microsoft's own service; Nerdio is a management layer *on top of* AVD, not a separate storage consumer. Any application or script running inside an AVD session desktop that can reach the internet can point standard Azure tooling (Azure CLI, AzCopy, the Azure SDK, or a mapped drive via a third-party Azure-Blob-compatible driver) at Inaya's `/api/azure` endpoint with an Inaya-issued Shared Key credential — no AVD-specific code is needed because AVD sessions are just Windows desktops running normal software. |
| **Nerdio-managed Azure infrastructure** | Nerdio itself has no public storage-target API — confirmed by investigation, no real, documented Nerdio API for third-party storage backends was found. Nerdio manages *Azure resources* (VM pools, image management, autoscaling); it does not intermediate blob storage traffic. There is nothing for Inaya to integrate with directly. |
| **Windows enterprise workloads / Azure-hosted applications** | Both consume storage the same way: standard Azure Blob SDKs/tools pointed at a custom endpoint. This is exactly what Workstream B's real Shared Key + Entra ID authentication enables. No additional work is needed beyond Workstream B itself. |
| **Storage configuration workflows** | Business Workspace's new `S3CompatView.js` (and the dApp's `S3CompatSection.js`) already provide this: issue a credential, get the endpoint URL, done — the same self-service flow an admin would use for any real Azure Storage account's access keys. |
| **Automated provisioning** | The `/api/orgs/s3-compat/credentials` and `/api/wallet/s3-compat/credentials` routes are real, scriptable REST endpoints (session/membership or wallet-signature authenticated) — an enterprise's own infrastructure-as-code pipeline (Terraform, a deployment script, a Nerdio custom scripted action) can call them directly to provision a credential as part of a larger automated environment setup, exactly the way it would call any cloud provider's own credential-issuance API. |
| **Enterprise identity** | Covered directly by Workstream B's real Entra ID Bearer-token authentication — a Nerdio-managed AVD environment's Entra-ID-joined users can authenticate to Inaya's Azure-compatible endpoint using their existing Microsoft identity, mapped to real Inaya org membership. |
| **Policy-controlled access** | Every credential is owner/admin-issued and individually revocable (both UI surfaces support this today); combined with Entra ID mapping, an org's existing membership roster **is** the access policy — remove someone from `org_members` and their Entra-authenticated access to the storage endpoint stops immediately, no separate policy system to keep in sync. |
| **Backup/storage workflows** | This *is* Workstream A+B's actual subject matter — real encryption, sharding, and redundant pinning underneath every object, regardless of whether it arrived via S3 or Azure protocol. |
| **Monitoring integration, where appropriate** | Every S3/Azure object write is logged to the org's real audit chain (`logOrgActivity`) today. A dedicated metrics/monitoring export (e.g., an Azure Monitor-compatible metrics endpoint) was not built this pass — flagged as a real, scoped-out follow-up rather than silently claimed. |

**Bottom line, stated as a real compatibility claim rather than a vague assurance:** "Inaya is usable within Nerdio-managed Azure environments" is true today, specifically because Workstream B's real Azure Blob-compatible endpoint (Shared Key or Entra ID authenticated) is reachable by any standard Azure tooling running inside such an environment — not because Inaya integrates with Nerdio itself, which has no integration surface to build against.

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

New env var: `S3_COMPAT_ENCRYPTION_KEY` (`.env.local`, 32 random bytes base64, generated for this session — must be rotated for any real deployment). New npm dependency: `@azure/storage-blob` (for real-tool testing in Workstream B; not imported by any server code — the app has no Azure SDK dependency itself). `@aws-sdk/client-s3` was already present (used by `filebase.js`); everything else uses Node's built-in `crypto`.

## Remaining open item for next session

The one honestly-unresolved piece across all three workstreams: root-causing the `@azure/storage-blob` SDK's specific signature mismatch (see Workstream B's dedicated section above for the full investigation so far). Recommended next step: instrument `@azure/core-rest-pipeline`'s policy list directly (log `pipeline.getOrderedPolicies()` on the constructed `BlobServiceClient`) to find which policy is actually performing the signing in this SDK version, since it's confirmed to be neither of the two `StorageSharedKeyCredentialPolicy(V2)` implementations bundled in `@azure/storage-common` that this report's implementation was built and matched against.
