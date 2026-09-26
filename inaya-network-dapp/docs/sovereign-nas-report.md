# Inaya Sovereign NAS / Edge Storage — Completion Report

Status: implemented and tested end to end on the one documented profile (a Linux
VM appliance). **Not** validated on physical hardware. Last verified 2026-09-25.

This report replaces the first-pass report, which built roughly a third of the
SOW and did not list the workstreams it skipped. Every workstream of
`Inaya_Sovereign_NAS_Actual_Edge_Appliance_SOW.md` is now either implemented and
tested, or has an explicit, evidenced boundary in §5. Deployment profile,
support matrix and the recovery runbook are in `docs/nas-runbook.md`.

## 1. What is real (and proven against real systems)

| Layer | What runs |
|---|---|
| Appliance | Ubuntu 26.04 (WSL2 VM): Samba 4.23, nfs-kernel-server (NFSv4.2), mdadm RAID1, Btrfs, ext4 quotas, POSIX ACLs, chattr immutability, avahi |
| Appliance agent | `src/lib/nas/appliance/inaya-nas-agent.py` — one validated JSON request per operation, argument-list commands only, path containment, hash-pinned versioned install with rollback |
| Control plane | `src/lib/nas/*` (25 modules), 49 API route files under `/api/orgs/nas`, an 18-section console, a worker (`scripts/nas-worker.mjs`, `/api/cron/nas`) |
| Reuse (nothing duplicated) | org identity/permissions (`orgGates`), cryptographic audit chain, Evidence Graph, Digital Twin engine, evidence exporter, s3-compat encrypted storage, notifications |

## 2. SOW workstream → implementation → proof

| SOW | Implementation | Proof |
|---|---|---|
| A Runtime / 8.3 local autonomy | Agent + boot recovery (`ensure_online`): after a restart pools re-attach, mirrors reassemble, services start; local file access needs no cloud | Real unclean VM kill; data, permissions, exports, immutable snapshot all intact (`nas-realclient` Test C). Appliance-to-Inaya reachability is measured and shown as degraded, not fatal |
| B SMB | Samba shares generated from a spec (valid/read/write/invalid lists, hosts allow, hidden, enabled, recycle); rename; fail-closed config validation with rollback | Windows client (this machine's SMB stack), `smbclient` |
| C NFS | NFSv4 exports, explicit client networks (`*`, `/0` rejected), ro/rw, root_squash | Kernel NFSv4.2 client: mount, CRUD, two concurrent clients, remount |
| D Pools / disks | mdadm RAID1 or single + Btrfs; status, guarded failure injection, replace/rebuild, scrub, disk inventory with SMART/temperature honestly UNKNOWN on virtual disks | Real disk failure: degraded but writable, rebuild ONLINE, scrub clean; a deliberately corrupted block is detected by checksums and the file read fails rather than returning bad bytes |
| E Snapshots | Btrfs copy-on-write (`copy-on-write`) or full copy (`full-copy`), manual + scheduled + retention, manifest hash, file/share restore side-by-side or in place (reason required) | `nas-storage` |
| F WORM / immutable | Immutable snapshot = writable snapshot → `chattr -R +i` → read-only (`rm -rf` and `btrfs subvolume delete` refused); WORM share = append-only directories + immutable settled files until retention; governance (owner override + reason) vs compliance (no override) | Root-level deletion/modify/rename blocked; real SMB user and Windows client cannot delete or overwrite a sealed file; locks lapse at retention |
| G Identity | Accounts only for org members holding a NAS role; groups; service accounts; password rotation; disable/enable; Samba lockout policy + unlock; org changes reconcile to the appliance. AD/LDAP not implemented | `nas-access` incl. real lockout (`NT_STATUS_ACCOUNT_LOCKED_OUT`) |
| H Permissions / ACLs | Org eligibility → Samba lists + POSIX folder ACLs incl. explicit deny; department boundary; fail closed | Samba refuses a read-only writer, a denied user, an ACL-denied folder, a disabled share; a revoked org member is locked out on the appliance |
| I Quotas | Btrfs qgroup limits; ext4 quota volumes with per-user limits; states NORMAL/WARNING/NEAR_LIMIT/HARD_LIMIT/FULL with alerts; non-enforcing backends say so | Writes refused at the limit (agent, real SMB user cap, Windows client error) |
| J Locking | Samba locking; `smbstatus` locks/sessions; plain-language `explainLock` | Windows exclusive lock blocks a second client (real sharing violation); lock released afterwards |
| K Recycle bin | Real vfs_recycle; list, restore (never overwrites silently), purge, retention purge | Deleted over SMB, restored byte-identical |
| L Ransomware | Baseline scan (change/delete ratios, extension changes, entropy jumps, ransom notes, failed logons, snapshot-deletion attempts) → classify → immutable snapshot → alert → lockdown (automatic only if enabled + CRITICAL, always expires; exempt shares never locked) | Simulation on test shares; lockdown made the share read-only over real SMB; recovery from the last clean snapshot |
| M Backup | One engine, target adapter; file-level dedup; resumable runs; read-back verification; recovery-point manifests; restore original/alternate/object | Test D (backup → delete local → restore → bytes match); interrupted and outage runs resume without duplicates |
| N Replication | rsync + manifest verification, repair of a corrupted replica, test failover (read-only) and promotion; NAS→Inaya = the backup engine on a schedule | `nas-protection`; same-host target only (§5) |
| O Multi-cloud | Inaya sovereign + S3-compatible targets (SSRF-safe, probe-tested, secrets encrypted); GCS interoperability code shared but untested and disabled until its test passes | Real Filebase backup + verify + restore |
| P Tiering | Proposals only; different-manager approval; verified copy before stubbing; reversible recall; legal holds | `nas-protection` |
| Q Hardware health | Measured CPU/RAM/load/disk I/O/SMB sessions/network; each value MEASURED/DERIVED/ESTIMATED/UNKNOWN | Overview + Hardware Health |
| R Discovery | Hostname, IPv4/IPv6, avahi mDNS verified inside the appliance (NAT limit stated) | `nas-access` |
| S Remote access | LOCAL_ONLY / PRIVATE_NETWORK / GATEWAY enforced by Samba `hosts allow`; public networks rejected; audited | LAN address refused in gateway mode; loopback works |
| T Console | 18 sections, plain-language overview cards | `npm run build` |
| U Evidence | Every consequential action → evidence row whose hash the audit chain commits to; NAS share is an Evidence Graph subject | Forged/edited rows and audit entries detected |
| V Proof of state | State commitments, drift diff, manifest re-derivation | `nas-protection` |
| W Digital Twin | Five NAS What-If scenarios on the existing engine; read-only; current vs simulated; explicit unknowns | Live registry and DB unchanged by simulations |
| X Recovery drill | Test restores; readiness never READY from a backup alone | `nas-protection` |
| Y Compliance package | `nasEvidence` section of the existing exporter; no certification claim | `nas-protection` |
| Z Updates | Preflight, config backup, hash-pinned install, auto rollback, never during a critical job | Update, blocked-by-job and rollback verified |
| 39 Jobs | Idempotent keys, checkpoints, backoff, stale-worker recovery, full state set | Racing/dead workers, resume |
| 37/38 Security | See §4 | `nas-security` |
| 47 Performance | Measured, with context, in `docs/nas-performance.json` | `nas-realclient` |

## 3. Test evidence

Real appliance and real MongoDB; no mocks of application logic. In-memory
pinning providers are used for speed in the backup tests; the cloud-target test
uses a real S3-compatible provider (Filebase).

| Suite | Tests |
|---|---|
| `nas-unit` (ACL mapping, quota calc, policy evaluation, backup selection/dedup, manifest hashing, evidence vocabulary, threat classification, SSRF guard) | 9 / 9 |
| `nas-storage` (pools, quotas, snapshots, WORM) | 23 / 23 |
| `nas-access` (permissions, groups, lockout, recycle, NFS, remote access, discovery) | 20 / 20 |
| `nas-protection` (backup, Test D, drills, cloud, replication, tiering, ransomware, jobs, twin, state, updates, worker) | 47 / 47 |
| `nas-security` (HTTP layer via real route handlers with minted sessions, tenant isolation, traversal/symlink, secrets, forged evidence, corruption) | 14 / 14 |
| `nas-realclient` (Windows SMB, Linux NFS/smbclient, unclean restart, measured throughput) | 15 / 15 |
| Regression: first-pass `nas.test.mjs` | 17 / 17 |

### Measured performance (SOW 47)

Recorded by `test/nas-realclient.test.mjs` into `docs/nas-performance.json`, with context. **Development-profile numbers only** — virtual disks, a virtual NAT network, an 8-vCPU laptop-class host — and not product guarantees.

| Measurement | Result | Client / filesystem |
|---|---|---|
| Sequential write, 100 MB (flushed to the server) | 264 MB/s | Windows SMB, ext4 directory share |
| Sequential read, 100 MB | 136 MB/s (upper bound: may be partly served by the Windows client cache) | Windows SMB, ext4 directory share |
| Sequential write / read, 200 MB | 223 / 213 MB/s | NFSv4.2 kernel client (loopback) |
| Sequential write, 100 MB | 137 MB/s | `smbclient` (loopback), Btrfs on RAID1 |
| 4 concurrent writers, 4 x 25 MB | 105 MB/s aggregate | `smbclient` x4, Btrfs on RAID1 |
| Snapshot creation (copy-on-write) including a full manifest hash of the data | 4.6 s | Btrfs (the snapshot itself is near-instant; most of this is hashing) |
| Appliance back in service after an unclean VM kill (first agent call) | 9.4 s | pools mounted, Samba/NFS started |

Encryption, backup and restore throughput to Inaya storage were not benchmarked separately; those paths run through the existing storage pipeline and depend on the pinning provider.

SOW 52A: Test A (Windows) ✔, B (Linux NFS) ✔, C (restart persistence) ✔, D
(Inaya backup) ✔, E (control-plane outage: cloud-dependent work queues and
retries, local access continues) ✔ via job states and outage tests, F (security
boundary) ✔, G (evidence) ✔, H (Digital Twin) ✔, I (real failure recovery:
disk failure/rebuild, corruption, VM kill) ✔.

## 4. Bugs the testing found and fixed

1. **Shell-string interpolation** (first pass): passwords/names went into `bash -c`. Replaced by the JSON agent with argument-list execution and validation (SOW 37).
2. **Lockdown loophole**: Samba's `write list` overrides `read only`, so a locked-down or read-only share still let listed users write. A read-only share never emits a write list now.
3. **Unlock did nothing**: `pdbedit -z` leaves Samba's autolock flag; unlock now clears it (`-c "[-L]"`).
4. **WSL2 idle shutdown** unmounted pools and stopped Samba; boot recovery on first agent call plus a keep-alive for the VM profile.
5. **Manifest injection**: a file name containing a newline could forge a manifest line; control characters are rejected in paths and such files are skipped and counted.
6. **Scrub reported as a crash** when it found errors; it now returns the counts.
7. Resume carried over stale failures; evidence and notification wiring in tests; several harness issues (SMB `!` escapes, `wsl.exe` re-parsing `sh -c`, Windows client caches).

## 5. Boundaries — stated, not hidden

* **Physical hardware (SOW 36A.2): not done.** The profile is a VM with virtual disks. SMART/temperature/UPS are UNKNOWN by design. This is the largest remaining gap.
* **NAS→NAS replication** was tested with the target on the same host (`transport: local-host`); cross-host transport is not implemented.
* **Immutable/WORM** is governance-grade: root on the appliance can lift the flag.
* **AD/LDAP, iSCSI, local S3 gateway, Kubernetes CSI: not implemented.** iSCSI was evaluated (kernel target modules load; no target stack installed; no use case) → FUTURE. macOS untested. GCS interoperability untested; Azure outbound not implemented.
* **Where it runs:** the control plane must be able to run the agent; the hosted website (Vercel) cannot reach a NAS on a customer network, so the worker is deliberately not in `vercel.json`.
* **Encryption on the backup path** is server-managed (SMB/NFS clients do not run Inaya's browser-side encryption).
* **Windows client behaviour:** deletes and handle releases can appear delayed because of client caching; tests assert the outcome on the appliance.
* **External:** the Pinata plan limit affects other Inaya storage; NAS backup uses provider fallback (Pinata first, then others). Two older evidence-exporter tests still fail for that reason.
* No compliance certification of any kind is claimed.

## 6. Regression and build

* First-pass `nas.test.mjs`: 17 / 17 (its backup step previously failed on the Pinata plan limit and now passes through provider fallback; one assertion was updated because recycle entries no longer expose absolute appliance paths).
* Shared-module suites touched by this work — business events, event passport, event simulate, evidence, Digital Twin, docs-content (which now includes the new Sovereign NAS page): **44 / 44**.
* Evidence exporter: 3 pass; 2 tests fail for the external reason already known — they write a test object through the pre-existing S3-compatible path, which Pinata rejects (`HTTP 403 ... plan usage limit`). They are unrelated to the NAS section added to the exporter.
* `npm run build`: compiled, exit 0; all 49 NAS route files, the cron route and the console are in the build output.

## 7. Deployment

New collections and indexes are created by `ensureOrgIndexes()`. New environment: none required beyond `NAS_ENCRYPTION_KEY` (already used). Start the worker on the appliance host. See `docs/nas-runbook.md`.
