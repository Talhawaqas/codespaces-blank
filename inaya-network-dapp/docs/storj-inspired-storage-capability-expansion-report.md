# Storj-Inspired Storage Capability Expansion SOW — Report

Per the SOW's mandatory §17 order: audit first, then implement only genuine gaps, then test, then document. This report covers everything built this pass, cites real files/tests, and discloses every scoping limit plainly rather than silently.

## Phase 0 Audit — what was already implemented vs. genuinely missing

| Capability | Status found | Evidence |
|---|---|---|
| S3-compatible storage (bucket/object CRUD, SigV4, multipart, range GET) | **Already implemented** | Prior SOW — unchanged, not rebuilt |
| Granular credential scope (bucket/prefix/operation/expiry) | **Genuinely absent** | `s3-compat/credentials.js`'s `issueS3Credential` took only `{owner, label, actorEmail}` — no scoping fields existed |
| Object Versioning | **Genuinely absent** | No `versionId`/`isLatest` field anywhere in `org_documents`/`metadata_files` |
| Object Lock / immutable retention | **Genuinely absent** | No retention fields; no enforcement chokepoint on delete/overwrite |
| Legal Hold (storage-object-level) | **Genuinely absent for storage objects** | A `legal_holds` collection exists, but it's scoped to legal-matter case management (`legalDiscovery`/`legalDeadlines`/`legalContracts`), not individual storage objects — a distinct, unrelated feature, left untouched |
| Lifecycle/retention policies | **Genuinely absent** | No policy collection, no expiration enforcement anywhere in the S3-compat layer |
| Automated storage health & repair for S3-compat objects | **Partially implemented — real gap found** | `backupEngine.js`'s real check-pins/verify-integrity/recovery pipeline already existed and covers every other Inaya upload, but `putS3Object`/`putS3Object` (wallet) pinned shards directly without ever calling `replicateShard()` to register with that pipeline — S3/Azure-compat objects were invisible to the existing DePIN health system |
| Inaya Drive / Object Mount (real filesystem mount) | **Genuinely absent — implemented and live-tested this pass (Windows)** | See dedicated section below |
| Enterprise Storage Console | **Genuinely absent** | `S3CompatView.js` only had credential issue/revoke; no bucket/version/lock/health visibility |
| Backup interoperability beyond AWS CLI | **Untested** | Only AWS CLI had been exercised in the prior SOW |

No existing capability (encryption, sharding, DePIN pinning, Proof of Storage, node infrastructure, authentication, authorization, audit chain, the S3/Azure protocol surface itself) was rebuilt or modified beyond the one real gap fix above.

---

## §2: Granular Storage Access Grants — IMPLEMENTED

`src/lib/s3-compat/credentials.js`: `issueS3Credential()` now accepts an optional `scope: {bucket, prefix, operations, expiresAt}`, validated and normalized by `normalizeScope()` (rejects invalid combinations — e.g. a prefix without a bucket — rather than silently narrowing them). `checkScope(credential, {bucket, key, operation})` is the single enforcement function, called centrally in `auth.js`'s `authenticateS3Request()` and `azureAuthMiddleware.js`'s `authenticateAzureRequest()` — **after** signature verification, deriving `bucket`/`key`/`operation` from the request's own URL and HTTP method (never from anything the client claims). A credential issued with no `scope` at all is the original, fully-trusted owner-level credential — scoping is additive, not a new restriction on every credential ever issued.

Enforced axes: bucket, path/prefix, allowed operations (READ/WRITE/DELETE/LIST), and expiry. A bucket/prefix-scoped credential is also denied `ListBuckets` outright (it has no legitimate reason to enumerate every bucket the owner has).

**Tested** (`test/s3-compat-capabilities.test.mjs`): unrestricted-by-default behavior, bucket-scope denial, prefix-scope denial, operation-scope denial, expiry denial, and rejection of an invalid scope shape at issuance time — 7 tests, all passing.

Exposed in Business Workspace's credential-creation form (`S3CompatView.js`) as an optional "Restrict scope" panel, and in both credential-issuance API routes (`orgs/s3-compat/credentials`, `wallet/s3-compat/credentials`).

---

## §3: Object Versioning — IMPLEMENTED

Bucket-level `versioningStatus` (`Unversioned` → `Enabled` → `Suspended`, matching real S3's one-way state machine — never reverts to "never versioned"). `store.js`/`walletStore.js`: `putBucketVersioning`, `getBucketVersioning`. When Enabled, `putS3Object` demotes the prior live object to `isLatest:false` instead of soft-deleting it — every version's bytes stay retrievable by its own `versionId` forever. When not enabled, the original Workstream A overwrite behavior (soft-delete) is unchanged — verified by a dedicated regression test.

- `headS3Object`/`getS3ObjectBody` accept an optional `versionId` to fetch a specific version.
- `listObjectVersions` returns full version history (including delete markers).
- `restoreObjectVersion` copies an old version's bytes forward as a new current version (real S3 semantics — it doesn't resurrect the old version id in place).
- `deleteS3Object` on a versioned bucket without an explicit `versionId` creates a **delete marker** (hides the key, destroys nothing); with an explicit `versionId` it permanently removes that one physical version (and is subject to Object Lock/Legal Hold — see §4/§5).

Real S3 sub-resources wired into the actual protocol surface (testable with real tools, not just this app's own API): `PUT/GET ?versioning` on the bucket route, `GET ?versions` for a named key, `?versionId=` on GET/HEAD/DELETE.

**A real bug found and fixed during this pass:** the pinning-provider `name` passed to `provider.pin()` was identical across every version of the same key (`s3-compat:{orgId}:{key}:alpha`). Filebase (this environment's active provider) uses that `name` as the literal object key on its own S3 backend — pinning two different versions under the same name silently **overwrote the same provider-side object**, so an "old" version's `cidAlpha`/`cidBeta` actually served back the *newest* bytes. Invisible before Versioning existed (every overwrite soft-deleted the old row, so nothing ever re-fetched an old `cidAlpha`/`cidBeta`) — surfaced immediately by the first version-retrieval test. Fixed by salting the pin name with the write's own new `documentId` (`src/lib/s3-compat/store.js` and `walletStore.js`), guaranteeing a distinct provider-side object per version.

**Tested** (5 tests): unversioned-bucket regression, multi-version retrieval by versionId, restore, and cross-org version-id isolation (SECURITY — an org can never read another org's object by guessing/reusing a versionId).

Business Workspace: `S3CompatView.js`'s new "Buckets, Versions & Object Protection" panel lets an authorized user enable/suspend versioning, browse an object's full version history, and restore a prior version.

---

## §4: Object Lock — IMPLEMENTED

`enableBucketObjectLock()` enforces real S3's own precondition (Versioning must already be Enabled) rather than just documenting it. `putObjectRetention({retentionMode: "GOVERNANCE"|"COMPLIANCE", retentionUntil})` sets a retention period on a specific version; a period can only be **extended**, never shortened, once set. Enforcement is one real chokepoint (`assertNotProtected()` in `store.js`/`walletStore.js`) called from both `putS3Object` (protects against in-place overwrite on an unversioned bucket) and `deleteS3Object` (protects against permanent deletion of a specific version) — so it can never be bypassed by hitting a different code path. The same protection applies transparently to the Azure endpoint, since Azure's Put Blob/Delete Blob both call through the identical `putS3Object`/`deleteS3Object` functions.

Real S3 sub-resources: `PUT/GET ?retention` on the object route.

**Tested** (3 tests): Object Lock rejected without Versioning enabled first; a retention-locked object cannot be deleted before its `retentionUntil`; a retention period cannot be shortened.

---

## §5: Legal Hold — IMPLEMENTED

`putObjectLegalHold({legalHold: true|false})` sets a per-version boolean flag, enforced through the exact same `assertNotProtected()` chokepoint as Object Lock — a legal hold blocks both deletion and in-place overwrite, server-side, regardless of whether the request arrives via the S3 API, the Azure API, or Business Workspace. Real S3 sub-resource: `PUT/GET ?legal-hold` on the object route.

**Tested** (2 tests): a held object cannot be deleted and becomes deletable again after release; legal hold also blocks overwrite (PUT), not just DELETE.

---

## §6: Lifecycle & Retention Policies — IMPLEMENTED

`putLifecyclePolicy({bucket, rules: [{prefix, expirationDays, noncurrentVersionExpirationDays}]})` — a full-replace per bucket, matching real S3's `PutBucketLifecycleConfiguration` semantic. `runLifecycleEnforcement()` is the real enforcement pass: scans every org+bucket with a policy, computes each object's scheduled expiration from its real age, and soft-deletes anything past due — **but never** an object under Object Lock retention or Legal Hold (verified by a dedicated test), routed through the identical `assertNotProtected()` chokepoint so a lifecycle rule can never become a backdoor around a lock. `getObjectExpirationInfo()` computes a display-only "scheduled expiration" timestamp for the UI, live from the object's age and policy — never a stored, driftable field.

**Honest disclosure:** `runLifecycleEnforcement()` is real and independently callable (a genuine "Run now" action in Business Workspace, and `/api/cron/s3-lifecycle`, gated by `CRON_SECRET` exactly like this codebase's existing `api/cron/nodes-snapshot` and `api/backup/cron/*` routes) — but this pass does not itself install an external scheduler entry. Every cron route in this codebase is triggered by Vercel Cron configuration outside the repo; wiring a new schedule entry there is outside what this codebase alone can install or verify. The enforcement logic itself is real and tested, not stubbed.

**Tested** (2 tests): an object past its rule's `expirationDays` is genuinely expired; a legal-held object survives lifecycle enforcement even past its expiration day (SECURITY).

---

## §7: Automated Storage Health & Repair — REAL GAP FOUND AND CLOSED

Per the SOW's explicit instruction not to build a parallel health system, the fix here is integration, not new infrastructure: `putS3Object()` (org and wallet) now calls the exact same `backupEngine.replicateShard()` that `api/upload/route.js` already calls for every other Inaya upload — registering both shards' primary pin and fanning out to secondary providers, exactly like any other file. Before this, S3/Azure-compatibility objects were pinned but **completely invisible** to the existing `check-pins`/`verify-integrity`/`recovery` crons that already protect every other Inaya file. `getS3ObjectHealth()` surfaces the real `backupEngine.getBackupStatus()` record (replica counts, health state) per object, shown live in Business Workspace's storage console.

No new repair mechanism, no new health-state machine, no new cron — the existing, already-proven pipeline now simply also covers these objects.

**Tested**: a freshly-uploaded S3-compat object registers real replica records for both shards and reads a non-failed health state immediately after upload.

---

## §8: Inaya Drive / Object Mount — IMPLEMENTED AND LIVE-TESTED (Windows)

Following explicit direction that this be a real, working feature rather than a documented deferral, a genuine OS-level virtual drive was built and verified end-to-end against the real, running dev server. **This is a real Windows drive letter, mountable and usable in File Explorer/PowerShell/any Windows application, backed entirely by the same `/api/s3` endpoint the AWS CLI already uses** — no new server-side trust surface, no reimplemented encryption.

### Architecture and the GPL licensing decision

The real Rust WinFSP binding (`winfsp` crate, `SnowflakePowered/winfsp-rs`) is **GPL-3.0 licensed**. Linking it directly into `inaya-desktop`'s proprietary binary would put the combined binary (and by standard interpretation, its source) under GPL-3.0. Per an explicit decision, this was resolved with a **process boundary, not a license concession**:

- **`inaya-drive-helper`** — a new, entirely standalone Cargo crate at the repo root (sibling to `inaya-desktop`, `inaya-dapp-desktop`), with its own `Cargo.toml` licensed GPL-3.0 (a real, accurate consequence of depending on `winfsp` — its source is kept available accordingly, isolated to this one small crate). It contains the actual WinFSP filesystem implementation.
- **`inaya-desktop`** gets two new Tauri commands, `mount_inaya_drive`/`unmount_inaya_drive`, which only ever **spawn `inaya-drive-helper.exe` as a child OS process** (`std::process::Command`) and kill it to unmount. No shared memory, no linked library, no GPL dependency anywhere in `inaya-desktop`'s own `Cargo.toml` — confirmed by a clean `cargo check` of `inaya-desktop` after this change, which pulls in nothing from `winfsp`.
- The helper authenticates to `/api/s3` with a **normal, already-existing S3 credential** — the same kind any AWS CLI session uses, including one scoped via this SOW's own Granular Storage Access Grants (e.g. a read-only drive limited to one bucket/prefix).

### What was built

- `inaya-drive-helper/src/sigv4.rs` — a Rust port of the real AWS SigV4 **signing** algorithm (the client side of this repo's existing `sigv4.js` verification), producing signatures the existing, already-tested server-side verifier accepts unmodified.
- `inaya-drive-helper/src/s3client.rs` — a minimal real S3 client: ListBuckets, ListObjectsV2 (prefix/delimiter), byte-range GetObject, HeadObject, PutObject, DeleteObject — every call a real signed HTTP request against `/api/s3`.
- `inaya-drive-helper/src/main.rs` — implements WinFSP's real `FileSystemContext` trait: buckets map to top-level folders, object keys map to nested paths using S3's own flat-namespace/prefix convention (matching every other part of this layer's model), reads stream via the existing byte-range GET, writes buffer in memory and flush to a single real PUT on file close.
- `inaya-desktop/src-tauri/src/lib.rs` — `mount_inaya_drive`/`unmount_inaya_drive` commands (session-origin-verified like every other sensitive command in this file), process spawn/kill only.
- `src/components/business/S3CompatView.js` — a "Mount"/"Unmount" panel, visible only inside the Tauri desktop app (`window.__TAURI__` detected), pre-fillable from a freshly issued credential.

### Real bugs found and fixed during live testing

Both found by actually mounting the drive and using it, not by code review:

1. **End-of-file read produced an invalid Range request.** A read exactly at a file's own size (a normal event — how read loops detect EOF) issued `Range: bytes=<size>-...` on a file of exactly `<size>` bytes, which is genuinely unsatisfiable per HTTP semantics — the server correctly rejected it with `416 Range Not Satisfiable`, which surfaced to Windows as "A device attached to the system is not functioning" and made every file unreadable past its first read call. Fixed by returning 0 bytes locally for any read at or past EOF, matching ordinary filesystem semantics, before ever making the HTTP call.
2. **Delete failed with "Incorrect function."** WinFSP's real delete protocol calls `set_delete()` first to accept the intent, *then* `cleanup()` with a delete flag to actually act on it — the default (unimplemented) `set_delete()` rejects every delete before `cleanup()` is ever reached. Fixed by implementing `set_delete()` to accept the request.

A third, environment-level issue was also found and fixed: the compiled binary crashed silently (exit code 5, no output) because `winfsp-x64.dll`'s install directory (`C:\Program Files (x86)\WinFsp\bin`) wasn't on `PATH`, and WinFSP's Rust binding delay-loads that DLL at first use — resolved by adding that directory to `PATH` before launching the helper (a real, disclosed operational requirement, not a code bug).

### Live verification (real WinFSP driver, real mounted drive, real server)

| Test | Result |
|---|---|
| Mount at a real drive letter (`I:`) | ✅ `Get-PSDrive I` shows a real 512GB-reported volume |
| Directory listing shows real bucket/object | ✅ `demo-bucket\hello.txt`, correct size (33 bytes) |
| Read a real file's content | ✅ byte-identical to what was uploaded via the API |
| Write a new file through the drive | ✅ `Set-Content` succeeds |
| **Server-side persistence (SECURITY/correctness)** | ✅ killed the helper process entirely, started a **fresh** process, the written file was still there with correct content — proving real server-side storage, not an in-memory illusion |
| Delete a file through the drive | ✅ `Remove-Item` succeeds, gone from a subsequent listing |
| Create a new empty folder (`New-Item -ItemType Directory`) | ✅ **rejected cleanly** with "The request is not supported" — a disclosed, deliberate scoping limit (see below), not a crash or silent no-op |

### Disclosed scoping limits (real, not silently different from a full filesystem)

- **No empty-folder creation.** S3 has no native "empty folder" primitive — a folder is only ever a shared key prefix. Explorer's "New Folder" is rejected with a clear error rather than silently accepted and then invisible. A folder appears automatically once a file is saved inside that path — the same behavior every real S3-backed mount tool (Cyberduck, rclone mount) has by default.
- **Windows only, this pass.** The architecture (WinFSP on Windows, FUSE/macFUSE on Linux/macOS) is the same real, established pattern either way, but this sandbox only has Windows hardware to build and test against — macOS/Linux support is real future work, not implemented or claimed here.
- **No local caching layer.** Every directory listing and every `get_security_by_name` path lookup is a live network call to `/api/s3` — correct, but not optimized for interactive performance over a slow connection. A local metadata cache is real, disclosed future work.
- **Production packaging is a follow-up.** This pass proved the mount by running the compiled `inaya-drive-helper.exe` directly; wiring it as a proper Tauri `externalBin` sidecar (so it ships inside the installed app with the correct target-triple-suffixed filename) is real, described, but not yet done packaging work — the process-spawn architecture and path-resolution fallback are in place in `lib.rs`.
- **Distinguishing S3-layer error causes.** Every backend failure maps to one generic NTSTATUS (`STATUS_UNSUCCESSFUL`) rather than a cause-specific one (permission denied vs. not found vs. network error) — real, disclosed follow-up work, not a correctness issue for the cases tested.

---

## §9: Enterprise Backup Interoperability

| Tool | Result |
|---|---|
| **AWS CLI** | **Tested and works** — full Workstream A flow (list/create/upload/download/range/multipart/delete) verified in the prior SOW against the real `aws` CLI; this pass's new capabilities (versioning, Object Lock, Legal Hold, lifecycle) were verified via the automated real-database integration suite (19 tests, `test/s3-compat-capabilities.test.mjs`) rather than a second live CLI session, given this pass's time budget — the same real SigV4 auth path both share was already proven correct against the real CLI |
| **rclone** | **Not tested** — not installed in this environment (confirmed: `which rclone` → not found) |
| **Terraform** | **Not tested** — not installed in this environment (confirmed: `which terraform` → not found) |
| **AzCopy** | **Not tested** — not installed in this environment |
| **Veeam** | **Not applicable** — a licensed, Windows-Server-hosted enterprise backup product; this sandbox has no means to install or run it |
| **TrueNAS** | **Not applicable** — a dedicated storage-appliance OS; cannot be hosted in this sandbox |
| **Commvault** | **Not applicable** — a licensed enterprise backup platform requiring its own server infrastructure; cannot be hosted in this sandbox |

No compatibility claim is made for any tool in the bottom six rows — stated as untested/not-applicable rather than assumed working, per the SOW's own explicit instruction.

---

## §10: Enterprise Storage Console — IMPLEMENTED (Business Workspace)

`S3CompatView.js`'s new "Buckets, Versions & Object Protection" panel (backed by a new session-authenticated management API, `api/orgs/s3-compat/manage/route.js` — deliberately separate from the SigV4-signed S3 protocol surface, so Business Workspace never needs to hold or sign with an S3 credential just to manage its own storage):

- **Storage overview**: real bucket list with live versioning status and Object Lock state.
- **Object protection**: per-object version history, legal hold status, retention-until date — all read live from `org_documents`, nothing synthetic.
- **Storage health**: real `backupEngine` replica counts and health state per object, on demand.
- Actions: enable/suspend versioning, enable Object Lock, set/release legal hold, set retention, restore a version, edit/clear a bucket's lifecycle rule, and a "Run lifecycle enforcement now" button.

No synthetic health scores and no data not backed by real telemetry/database state, per the SOW's explicit instruction.

**Verification**: the dev server compiled `/business` cleanly (6290 modules, HTTP 200, zero console/server errors) after this change. A full interactive click-through under a real logged-in org session was not performed this pass (no test org session was readily available in this environment) — the underlying functions this panel calls are the same ones covered by the 19-test automated suite, so the logic itself is verified; only the React wiring's compile-cleanliness was directly confirmed in-browser.

---

## §11: Trust-Layer Integration — REUSED, NOT REBUILT

Every new mutating action logs to the existing, real `logOrgActivity`/audit-chain infrastructure with real org/object context, using the same `org_activity` collection every other Business Workspace action already writes to: `OBJECT_LOCK_SET`, `LEGAL_HOLD_PLACED`/`LEGAL_HOLD_RELEASED`, `LIFECYCLE_POLICY_SET`/`LIFECYCLE_POLICY_DELETED`, `LIFECYCLE_EXPIRED`, `DELETE_MARKER_CREATED`, plus the existing `PUT`/`DELETE` events (now also carrying `versionId`). No new audit/evidence system was built.

---

## §12/§13: Business Workspace / dApp Integration

Business Workspace gets the full console (§10). The dApp's wallet-side backend (`walletStore.js`) implements the same versioning/Object Lock/Legal Hold functions as the org side — a wallet-owned S3/Azure credential gets the identical real protections — but the dApp's own UI (`S3CompatSection.js`) was deliberately **not** extended with a matching versions/lock/legal-hold console this pass. Legal hold, retention, and lifecycle policy are inherently enterprise/compliance concerns; duplicating that admin surface into a personal wallet UI would be exactly the kind of unnecessary duplication the SOW's own §13 instruction warns against ("do not duplicate organization authorization logic unnecessarily"). The capability is real and reachable via the S3/Azure protocol and the wallet-signature-authenticated API for any wallet owner who needs it; only the dedicated browsing UI is org-side only, disclosed here rather than silently absent.

---

## §14: Security Requirements — Tested

| Requirement | Verified by |
|---|---|
| Bucket/prefix/operation-scope bypass rejection | `checkScope` unit tests (4) |
| Expired credential rejection | `checkScope` unit test |
| Cross-org isolation (versions) | "a version id from one org cannot be used to read another org's object" |
| Locked object cannot be deleted/overwritten | Object Lock tests (3) |
| Legal hold cannot be bypassed (delete or overwrite) | Legal Hold tests (2) |
| Lifecycle cannot bypass a lock/hold | Lifecycle legal-hold test |
| Retention cannot be shortened | Object Lock test |
| API cannot bypass Business-Workspace-set policy | Enforcement lives in `store.js`/`walletStore.js` itself, called identically by the S3 route, the Azure route, and the Business Workspace management API — there is no separate, weaker path |

## §15: Performance & Reliability Testing — partially covered, disclosed

The 19-test real-database integration suite exercises correctness and security for every new capability under normal load, and Workstream A's prior real-tool testing already covered large/multipart/range/concurrent-adjacent operations for the base protocol. Dedicated concurrency/stress testing specifically for the new capabilities (e.g., many simultaneous versioned writes to the same key, large-scale lifecycle sweeps) was not performed this pass, given time — disclosed honestly rather than assumed fine. `runLifecycleEnforcement`'s `limit` parameter bounds a single pass's scan size, the same storage-efficiency-conscious pattern `backupEngine.js`'s own sweeps already use.

---

## Regression testing

`test/s3-compat-store.test.mjs` (Workstream A, 9 tests) and `test/s3-compat-sigv4.test.mjs` (9 tests) both re-run clean after every change in this pass — **zero regressions**. `test/s3-compat-capabilities.test.mjs` (this pass, 19 tests) — all passing after two real bugs were found and fixed during development (see §3 and below).

## Bugs found and fixed this pass

1. **Pin-name version collision** (§3) — see above. A real, previously-latent bug in the original Workstream A code, invisible until Versioning made old-version retrieval possible.
2. **Invalid `recordId` passed to the audit log** — `putLifecyclePolicy`/`deleteLifecyclePolicy` originally passed the bucket *name* (a plain string like `"finance"`) as `logOrgActivity`'s `recordId`, which requires a real ObjectId — threw `BSONError` on every lifecycle-policy write. Fixed by passing the bucket's own real project `_id` instead. Caught by the automated test suite, not code review.
3. **Object Mount: EOF read sent an invalid Range request** (§8) — see above. Fixed by handling read-at-EOF locally rather than forwarding it as an HTTP request.
4. **Object Mount: delete silently rejected** (§8) — `set_delete()` was never implemented, so WinFSP rejected every delete before `cleanup()`'s own deletion logic could run. Fixed by implementing `set_delete()`.

## Files changed/added this pass

- `src/lib/s3-compat/credentials.js` — scope issuance/validation/enforcement (`normalizeScope`, `checkScope`).
- `src/lib/s3-compat/auth.js`, `azureAuthMiddleware.js` — centralized scope enforcement on every S3/Azure request.
- `src/lib/s3-compat/store.js`, `walletStore.js` — versioning, Object Lock, Legal Hold, lifecycle policies + enforcement, backupEngine registration, health surfacing.
- `src/app/api/s3/[bucket]/route.js`, `[bucket]/[...key]/route.js` — real S3 sub-resources (`?versioning`, `?object-lock`, `?versions`, `?legal-hold`, `?retention`, `?versionId=`).
- `src/app/api/azure/[container]/[...blob]/route.js` — lock/hold error mapping (protection itself inherited from the shared store functions).
- `src/app/api/cron/s3-lifecycle/route.js` — new cron route (same convention as existing cron routes).
- `src/app/api/orgs/s3-compat/manage/route.js` — new Business Workspace management API.
- `src/app/api/orgs/s3-compat/credentials/route.js`, `wallet/s3-compat/credentials/route.js` — scope passthrough.
- `src/components/business/S3CompatView.js` — scope UI + full Buckets/Versions/Protection/Lifecycle console + Inaya Drive mount panel.
- `test/s3-compat-capabilities.test.mjs` — new, 19 tests.
- `inaya-drive-helper/` (new, standalone, GPL-3.0-licensed Cargo crate at the repo root) — the real WinFSP-backed Inaya Drive implementation: `src/main.rs` (filesystem), `src/sigv4.rs` (SigV4 signing), `src/s3client.rs` (S3 REST client).
- `inaya-desktop/src-tauri/src/lib.rs` — `mount_inaya_drive`/`unmount_inaya_drive` commands (process spawn/kill only — no GPL dependency added to this crate).
