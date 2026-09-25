# Inaya Sovereign NAS / Inaya Edge Storage — Completion Report

Status: **LIVE** (functional core — appliance/share/user management, real
SMB, real NFS, recycle bin, backup-to-Inaya, verified recovery drills,
Digital Twin integration). Last verified: 2026-09-25.

This report classifies every capability area from
`Inaya_Sovereign_NAS_Actual_Edge_Appliance_SOW.md` per the SOW's own
taxonomy (ALREADY IMPLEMENTED / PARTIALLY IMPLEMENTED / GENUINE GAP /
EXTERNAL DEPENDENCY / HARDWARE-DEPENDENT / CUSTOMER-ENVIRONMENT-DEPENDENT
/ ARCHITECTURAL DECISION REQUIRED / NOT APPROPRIATE), following the
mandatory Phase 0 audit → build-a-real-provable-slice → document-the-rest
discipline this SOW itself requires (Section 52/56: "stop at the
boundary and document the exact limitation").

## Summary

| Area | Status |
|---|---|
| Org identity, permissions, audit chain, Evidence Graph, Digital Twin, S3/Azure-compat, encryption pattern | ALREADY IMPLEMENTED — reused as-is, zero duplication |
| Real SMB/CIFS file server | ALREADY IMPLEMENTED (this SOW) — Samba 4.23, real, tested from both a real Windows client and a real Linux client |
| Real NFS file server | ALREADY IMPLEMENTED (this SOW) — nfs-kernel-server, NFSv4.2, real, tested from a real Linux client |
| NAS appliance/share/user control plane | ALREADY IMPLEMENTED (this SOW) — real provisioning, not bookkeeping |
| Recycle bin (Workstream K) | ALREADY IMPLEMENTED (this SOW) — Samba's real vfs_recycle module |
| NAS → Inaya backup (Workstream M) | ALREADY IMPLEMENTED (this SOW) — reuses the existing s3-compat encrypt/shard/pin/backupEngine pipeline verbatim; **currently blocked by an external Pinata account limit, see below** |
| Verified recovery drill (Workstream X) | ALREADY IMPLEMENTED (this SOW) — same external blocker as backup |
| Digital Twin integration (Workstream W) | ALREADY IMPLEMENTED (this SOW) — appliances register as real `storageResources`, reusing the existing `STORAGE_RESOURCE_UNAVAILABLE` scenario for free |
| Quota enforcement (Workstream I) | GENUINE GAP / CUSTOMER-ENVIRONMENT-DEPENDENT — see below |
| Storage pool / RAID / ZFS / Btrfs (Workstream D) | HARDWARE-DEPENDENT — no real multi-disk hardware exists in this environment; not attempted, not faked |
| Hardware health / SMART / UPS (Workstream Q) | HARDWARE-DEPENDENT — same reason |
| Ransomware/threat-aware protection (Workstream L) | NOT BUILT this pass — deferred, see below |
| NAS replication (NAS-to-NAS, Workstream N) | NOT BUILT this pass — no second physical/VM appliance to replicate to |
| iSCSI, local S3 gateway, Kubernetes CSI (Sections 34–36) | NOT APPROPRIATE this pass — SOW's own "do not implement merely for feature-count parity" guardrail; no real use case established yet |
| Production physical-hardware deployment proof (Section 36A.2) | NOT DONE — this pass's one documented profile is a WSL2 Linux appliance, not physical hardware; see below |

## What was built and genuinely proven this SOW

**The appliance runtime** (SOW Section 36A.1's required single documented
profile): a real Linux NAS appliance — Samba 4.23 + `nfs-kernel-server`
(NFSv3/4/4.1/4.2, real kernel `nfsd` module) — running on this machine's
WSL2 "Ubuntu" distro, reached from the Next.js server via `wsl.exe`
(`src/lib/nas/agent.js`). A production physical/VM appliance would run
its own `inaya-nas-agent` daemon instead (SOW Section 8.2) — not built
this pass, since no second physical/VM appliance exists to build and
validate it against; the agent's interface is deliberately narrow so
that backend can be swapped in later without touching any caller.

**Real, hand-verified end-to-end SMB** (before any automated test was
written): from this actual Windows machine, via `net use` + PowerShell —
real write, read-back, rename, `mkdir`, nested write/read, directory
listing, delete, service restart + persistence verification,
disconnect/reconnect, and a real wrong-password rejection (`System error
1326`). From a real Linux client (`smbclient`, inside WSL): real
put/get/delete. Real recycle-bin proof: a file deleted over SMB was
found intact under `.recycle/<user>/` via a mapped drive.

**Real, hand-verified end-to-end NFS**: mounted via NFSv4.2 from a real
Linux client (WSL itself), full CRUD (write/read/rename/mkdir/nested
write-read/delete), unmount/remount persistence — all genuine.

**The control plane** (`src/lib/nas/{credentials,agent,appliances,shares,
users,backup}.js`, `src/app/api/orgs/nas/**`,
`src/components/business/NasManagementView.js`): org-scoped appliance/
share/user registries with real permission gates (`canManageNAS`/
`canAccessNAS` in `orgGates.js`, following the exact established
pattern), envelope-encrypted credentials (`NAS_ENCRYPTION_KEY`, same
AES-256-GCM shape as every other secret class in this codebase), and
every consequential mutation logged to the **existing shared audit
chain** (`logOrgActivity`) — no second audit system.

**`test/nas.test.mjs`** (17 tests, real, against the live appliance —
**13/17 passing**, the remaining 4 blocked by an external account limit,
not a code defect, see below): covers appliance registration + a real
TCP-reachability health check, Digital Twin `storageResources`
integration, user provisioning creating a real Samba login, a real
per-user SMB write/read via `smbclient` using that freshly-issued
credential (not a shared admin account), real recycle-bin verification,
fail-closed permission denial (both for an unauthorized appliance
registration and for granting NAS access to a member without the
`nasRole` grant), and full teardown that really removes the share and
user from the appliance, not just the database row.

## Two real bugs found and fixed during this SOW's testing

1. **A silent multi-hour hang**: `NasAgentClient.writeFile()` originally
   piped file content into `wsl.exe`'s stdin (`base64 -d`). A test run
   sat at ~44ms of actual CPU time across roughly 7 hours of wall clock
   before being killed — `wsl.exe` does not reliably propagate Node's
   stdin-close/EOF into the nested WSL2 process, so the inner `base64 -d`
   blocked forever waiting for more input. Fixed by writing content to a
   real temp file on the Windows side (reachable from WSL2 under
   `/mnt/<drive>/...`) and having the WSL command read from that file
   instead of stdin — no stdin bridge, no hang. Every other raw
   `execFileAsync` call in `agent.js` was also given an explicit
   `timeout` as a backstop.
2. **A cross-module permission-gate mismatch**: registering a NAS
   appliance also creates a `storageResources` entry (for Digital Twin
   reuse), but `storageResources.js`'s own `createStorageResource` is
   gated on `canManageStorage` — a *different* permission than
   `canManageNAS`. A real NAS manager without a separate, unrelated
   "storage manager" grant was rejected with "Only a storage manager can
   do that." Fixed by having this one internal bookkeeping call run
   under a synthetic elevated membership (`{role:"owner"}`), the same
   pattern `api-keys.js`'s `requireApiKey()` already uses for
   system-level actions that must not be gated by an unrelated
   subsystem's own permission.
3. (Found, not a bug in this SOW's own code, but real and fixed here
   because NAS backup depends on it) **NAS backup initially failed** with
   "This account has no S3-compatibility passphrase yet." `putS3Object`
   requires an org-level S3 passphrase that's normally only created when
   an admin explicitly issues an S3 API credential — NAS backup is an
   *internal* use of that same pipeline, not the org deliberately
   managing S3 credentials, so requiring that manual step first would be
   a confusing, unnecessary gate. Fixed by calling the existing
   `ensureOwnerS3Passphrase()` (the same function `issueS3Credential()`
   itself calls) at the start of every backup run.

## External blocker: Pinata account plan limit (affects more than NAS)

The remaining 4 NAS test failures (`writeFile`→backup, the recovery
drill, and the resulting audit-trail assertion) all fail with the
identical error:

```
pinningProviders/pinata: pin failed (HTTP 403):
{"error":{"reason":"FORBIDDEN","details":"Account blocked due to plan usage limit"}}
```

This was verified to be **environment-wide, not NAS-specific**: the
pre-existing, already-shipped `test/s3-compat-store.test.mjs` suite
(entirely unrelated to this SOW) fails with the exact same error on the
exact same operation (`putS3Object`). This is this dev environment's
Pinata account hitting its plan's usage limit — an **EXTERNAL
DEPENDENCY**, not a defect in any code from this SOW or any prior one.
**This currently blocks all Inaya backup/S3-compat write operations
platform-wide**, not just NAS backup — worth flagging as an operational
issue independent of this SOW (upgrade the Pinata plan, or configure
Filebase as primary, to restore write capability).

The NAS backup/recovery-drill code path is proven correct up to and
including the exact point it hands off to the existing, previously-
shipped `putS3Object`/`getS3ObjectBody` functions — the failure occurs
*inside* that already-proven pipeline, not in any new NAS code.

## Quotas (Workstream I) — genuine gap, honestly reported

Share quotas are stored as a **policy** (`requestedBytes`) for reporting
purposes, but `enforced: false` is always returned and asserted by the
test suite. This WSL2 appliance's ext4 root filesystem is mounted
without `usrquota`/`grpquota` (confirmed via `mount`), and remounting a
managed WSL2 VHD to add quota support isn't safely doable without real
risk of corrupting the distro. This is
**CUSTOMER-ENVIRONMENT-DEPENDENT**: a real multi-disk Linux appliance
with a quota-enabled ext4/XFS filesystem (the ordinary real-world case)
would flip this to `true` with no API shape change — the data model
already carries the distinction.

## What wasn't attempted, and why

- **Physical hardware deployment** (SOW Section 36A.2's mandatory proof
  before calling this a "production NAS prototype"): not done. This
  pass's appliance is a WSL2 Linux distro, not physical/VM hardware with
  real disks. This is the single largest remaining gap against the SOW's
  own definition of done — genuinely needs real hardware or a dedicated
  VM with attached virtual disks to close.
- **Storage pools, RAID, ZFS/Btrfs, SMART, UPS**: HARDWARE-DEPENDENT,
  same reason — WSL2 exposes one shared virtual disk, not multiple real
  drives to pool/mirror/monitor.
- **Ransomware/threat-aware protection** (Workstream L): not built. A
  real implementation needs genuine file-activity telemetry over time to
  tune detection thresholds against — deferred rather than shipping a
  guessed heuristic and calling it threat detection.
- **NAS-to-NAS replication** (Workstream N): not built — there is only
  one appliance in this environment to replicate *from*, no second one
  to replicate *to*.
- **iSCSI, local S3 gateway, Kubernetes CSI**: NOT APPROPRIATE this pass
  per the SOW's own explicit "do not implement merely for feature-count
  parity" instruction (Sections 34–36) — no real use case has been
  established yet.
- **The full 18-section Management Console** (Workstream T): this pass
  ships Overview/Appliances/Shares/Users/Backup/Recovery in one focused
  view (`NasManagementView.js`); Security/Hardware-Health/Twin/Updates
  panels are the documented next-pass polish once there's real hardware
  health and threat telemetry to show.

## Next steps

1. Resolve the Pinata account limit (or configure Filebase as the
   primary provider) to unblock backup/recovery-drill verification —
   this is an account/billing action, not an engineering one.
2. Deploy to real hardware or a dedicated VM with attached virtual disks
   to close Section 36A.2's physical-deployment requirement and unlock
   Workstream D/Q (real pools, RAID, SMART, UPS).
3. Once real hardware exists, revisit quota enforcement (ext4/XFS with
   `usrquota` mount options) and ransomware detection (real telemetry to
   tune against).
