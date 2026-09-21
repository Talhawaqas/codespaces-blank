# IBM Cloud VPC Storage-Inspired Capability Expansion

**Status:** Implemented and tested (single-org scope). **Date:** September 2026.

## Phase 0 Audit — What Already Existed

Full detail in `docs/IBM_VPC_STORAGE_CAPABILITY_AUDIT.md`. The one finding that shaped every design decision below: **Inaya has no compute/VM/hypervisor runtime of any kind.** IBM VPC's block-volume model assumes a running instance to attach a device *to*; Inaya has nothing of the sort. Rather than fabricate a fake compute layer (explicitly forbidden by the SOW) or quietly skip the whole workstream, every "physical infrastructure" capability in this SOW was rebuilt as an honest, useful, logical control-plane abstraction — and labeled as exactly that, never implied to be more.

## What Was Built

### Workstream A — Unified Storage Resource Registry (`src/lib/storageResources.js`)

A genuine gap: no generic resource envelope existed anywhere in this codebase before this SOW (every domain has its own bespoke Mongo collection). `createStorageResource`/`listStorageResources`/`getStorageResource`/`expandStorageResourceCapacity`/`deleteStorageResource` — every resource is backed by a real S3-compat bucket (`ensureS3Bucket`, unchanged), so its actual bytes live in the same, already-encrypted, already-tested storage path as everything else in the app. Capacity can only increase, never decrease, per the SOW's own explicit rule.

### Workstreams B/C/D — Block Volume & File Share Control Planes

Both resource types carry a static `physicalCapability` field (`logical_only_no_compute_attach` / `logical_only_no_nfs_server`) that is never upgraded to imply real capability. `attachVolume`/`detachVolume` implement a real reservation/lock mechanism — preventing two declared consumers from believing they own the same volume concurrently — using a caller-supplied free-text label (`attachedTo`), never a fabricated device path. `addMountTarget`/`removeMountTarget` on a file share are declared, bookkeeping-only records (`physicallyMountable: false`), never a real, connectable NFS endpoint.

### Workstreams E/F/G/H/I — Snapshot Engine, Consistency Groups, Cross-Region Copy, Fast Restore, Cross-Org Sharing (`src/lib/storageSnapshots.js`)

- **Snapshots** are built entirely on the existing S3-compat versioning primitives (`putBucketVersioning`, per-key `versionId`) — creating one auto-enables bucket versioning, then records a manifest of every current key's `versionId`. No bytes are copied at capture time, so the "incremental" claim is genuinely true, not asserted. Restoring is a real, normal copy-forward restore (read each manifest entry's recorded version, write it back as the new current version) — the same technique real S3 tooling uses, since neither S3 nor Inaya has a magic rollback pointer.
- **Consistency groups** capture multiple resources' snapshots sequentially, not atomically, and every group record honestly carries `consistencyBoundary: "SEQUENTIAL_NOT_ATOMIC"` plus its own real `captureStartedAt`/`captureCompletedAt` window — never a false claim of simultaneous crash consistency.
- **Cross-region copy** moves a snapshot's referenced object versions into a different resource (which may carry a different logical `region` label — Inaya has no real geography, confirmed by the audit) using the same `getS3ObjectBody`/`putS3Object` primitives every other read/write path already uses.
- **Fast restore** was not built — no backend primitive exists to accelerate a restore. `restoreSnapshot()` is a normal restore and is never labeled otherwise.
- **Cross-org sharing** is a real grant/revoke/expiry model (`shareSnapshot`/`revokeSnapshotGrant`/`resolveSnapshotGrant`), fails closed on wrong recipient, revocation, or expiry.

### Workstreams J/K/L/M — Backup Policy Engine (`src/lib/storageBackupPolicies.js`)

Complementary to, not a duplicate of, `cloudBackupScheduler.js` (Feature 3 of the Modular Enterprise Adoption Features SOW) — that system pulls FROM an external cloud source INTO one hardcoded Inaya bucket; this one policy-selects (by tag) and recurringly snapshots Inaya's *own* resources, with real multi-plan-per-policy (`daily`/`weekly`/`monthly`/`longTerm`) and real retention enforcement (oldest snapshots beyond a plan's `retentionCount` are deleted, every deletion audited via `logOrgActivity` — never silent). Health status (`HEALTHY`/`WARNING`/`DEGRADED`/`FAILED`/`PAUSED`/`UNKNOWN`) is computed with the exact same thresholds `cloudBackupScheduler.js` already established, for a consistent operator experience across both backup systems.

### Workstreams T/U/V — Evidence Graph & Digital Twin Integration

Every mutation across all three new lib files calls the existing `logOrgActivity` — no second audit mechanism. `digitalTwin.js` gained a bespoke `STORAGE_RESOURCE` dependent-resolver block (not a generic `DEPENDENT_RESOLVERS` table entry — storage resources are org-wide, gated by the distinct `canAccessStorage` permission, not department membership; the generic table's own no-departmentId-means-visible-to-everyone default would have been a real permission leak here). Two new Digital Twin scenarios were added: `STORAGE_RESOURCE_UNAVAILABLE` and `BACKUP_POLICY_DISABLED`, both read-only, both gated the same way.

### Workstream Q — Tags

Generalized the existing S3-compat object-level tag validation (`normalizeTags`, same limits: 10 tags max, 128-char keys, 256-char values) across every new resource type, and added `matchesSelector` for tag-based backup-policy targeting.

## What Was Explicitly Not Built, and Why

- **Fast restore / clone** — no backend primitive exists to accelerate it; documented, not faked.
- **Real physical block-volume attach or real NFS mounting** — structurally impossible without a compute layer that doesn't exist; built as honest logical control planes instead (see above).
- **IBM Cloud Object Storage interop validation** — no IBM Cloud credentials exist in this environment (IBM Cloud would not accept the available payment method for account creation); not executed, not simulated.

**Built in a later pass, once real Go tooling was available:** a custom Terraform provider (`terraform-provider-inaya`, at `terraform-provider-inaya/` in this repo) exposing `inaya_storage_resource`, `inaya_snapshot`, `inaya_backup_policy`, and `inaya_backup_plan`. Required adding a bearer-API-key-authenticated `/api/public/v1/storage/*` route namespace alongside the existing session-cookie-only `/api/orgs/storage/*` routes (Terraform runs headless and has no browser session), plus two small additive backend functions (`deleteBackupPolicy`/`deleteBackupPlan` — the `deletedAt` field already existed in both collections' schemas with nothing that ever set it). Full create/read/update/delete cycle tested against a real running dev server with real MongoDB-backed state, not a dry run — see `terraform-provider-inaya/README.md` for exactly what was verified and the one real bug (`health`/`created_at` computed fields missing from create-time responses) found and fixed during that testing. Not published to the Terraform Registry — local-only via `dev_overrides` for now.
- **Context-based/conditional access restrictions** — no concrete use case identified yet beyond the existing role/department/assignment model.
- **Business Workspace UI** for mount-target management and cross-org snapshot sharing — API-only for now, matching this codebase's own established "ship a complete, tested API surface first" precedent.

## Testing

`test/storage-resources.test.mjs` (12 tests), `test/storage-snapshots.test.mjs` (11 tests), `test/storage-backup-policies.test.mjs` (8 tests), `test/digital-twin-storage.test.mjs` (4 tests) — 35 new tests total, all passing against the real database and real S3-compat storage write path. `test/digital-twin.test.mjs`'s existing 11 tests re-run with zero regressions.

Coverage includes: real backing-bucket creation, tag validation limits, capacity expand-only enforcement, volume attach/detach as a genuine conflict-preventing reservation, mount targets as honest bookkeeping, org isolation on every new collection, real snapshot capture with an independently-recomputable integrity hash, real copy-forward restore of genuinely-overwritten content, consistency groups' honest non-atomic boundary, cross-region copy moving real bytes, cross-org snapshot sharing failing closed on wrong-org/revocation/expiry, tag-selector-scoped backup policy execution, retention deleting exactly the right number of old snapshots (never silently more or fewer) with every deletion audited, and the Digital Twin's new storage scenarios both denying a non-storage member and never mutating any real record they read.

## Two Real Bugs Found and Fixed During Testing

1. `storageSnapshots.js`'s `captureManifest()` originally assumed `listS3Objects()`'s `contents` entries had a `.key` field — the real shape (confirmed by direct inspection) is the raw `orgDocuments` document, keyed by `.filename`. This silently produced an empty manifest for every snapshot. Fixed, and simplified to skip a redundant per-key `headS3Object()` round trip since the listing already returns everything needed.
2. `createSnapshot()`'s success return value omitted `snapshotType` despite setting it on the stored document — caught by a test asserting the returned value, not just the database row.

Production build compiles cleanly with all 16 new API routes and the new Business Workspace view registered.

## A Note on Honesty Discipline

Every "logical only" / "declared, not physical" limitation from the backend is surfaced verbatim in the UI (`StorageControlPlaneView.js`'s own header text) rather than hidden behind reassuring language. No claim of IBM certification, IBM API compatibility, or physical IOPS/throughput enforcement is made anywhere in this codebase as a result of this SOW.
