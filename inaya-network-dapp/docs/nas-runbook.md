# Inaya Sovereign NAS — Deployment Profile, Support Matrix and Recovery Runbook

Code: `src/lib/nas/`, appliance agent `src/lib/nas/appliance/inaya-nas-agent.py`,
API `/api/orgs/nas/*`, console `src/components/business/NasManagementView.js`.
Read this together with `docs/sovereign-nas-report.md` (what was built and what
was measured).

## 1. The one supported profile (SOW 36A.1)

| Item | Value |
|---|---|
| Profile | **VM-based development/test appliance**: a Linux distro under WSL2 on a Windows host, reached by the control plane through `wsl.exe` |
| CPU architecture | x86-64 (tested: 11th-gen Intel Core i7-1165G7, 8 vCPU visible) |
| Minimum CPU / RAM | 2 vCPU / 4 GB for the appliance VM (tested with 16 GB host RAM, 8 vCPU) |
| Boot device | The WSL2 distro virtual disk (ext4) |
| Data drives | Two or more **virtual** disks (loop-attached image files) per RAID1 pool; one for a single pool |
| Drive types | Virtual only. Physical SATA/SAS/NVMe drives have **not** been used |
| Filesystem / storage stack | mdadm RAID1 → Btrfs (pool shares); ext4 with quota (per-user quota shares); ext4 directory (legacy shares) |
| Distribution | Ubuntu 26.04 LTS, kernel 6.18.33.2-microsoft-standard-WSL2 |
| Required services/packages | `samba` 4.23, `nfs-kernel-server`, `mdadm` 4.5, `btrfs-progs` 6.17, `acl`, `quota`, `rsync`, `smartmontools`, `avahi-daemon`, `python3` ≥ 3.10 (tested 3.14) |
| Network | WSL2 NAT virtual switch (Windows reaches the appliance at its WSL address); Linux clients over loopback |
| Storage controller / UPS | None (virtual). UPS awareness is UNKNOWN by design |
| Optional | SMART (returns a hypervisor value on virtual disks, labelled as such), avahi mDNS |

**Not claimed:** any physical hardware, any other Linux distribution, ARM64,
macOS clients, production performance.

## 2. Support matrix (SOW 45 Phase 15)

| Area | Status | Evidence |
|---|---|---|
| SMB from **Windows** (this machine's own SMB client) | Tested: connect, mkdir, create/write/read/modify/rename/delete, recycle restore, 100 MB transfer with byte match, interrupted-transfer retry, concurrent writers, exclusive-lock conflict, permission denial, WORM refusal, quota error | `test/nas-realclient.test.mjs` |
| SMB from Linux (`smbclient`) | Tested: permissions, quotas, WORM, lockout, throughput | `nas-access`, `nas-storage`, `nas-realclient` |
| NFSv4.2 from Linux (kernel client) | Tested: mount, CRUD, two concurrent clients, remount persistence, client restrictions | `nas-access`, `nas-realclient` |
| macOS / Finder | **Not tested — not claimed** | — |
| NFSv3, iSCSI, S3 gateway, Kubernetes CSI | **Not implemented** (§6) | — |
| Active Directory / LDAP | **Not implemented** (needs a domain controller) | `identityCapabilities()` |
| Storage pools (RAID1/single + Btrfs) | Tested incl. real disk-failure injection, degraded operation, rebuild, scrub, and detection of a corrupted block | `nas-storage`, `nas-security` |
| Snapshots, immutable locks, WORM | Tested against deletion by root-level commands and real SMB users | `nas-storage`, `nas-realclient` |
| Backup targets | Inaya sovereign storage (tested); **Filebase (real S3-compatible provider, tested)**; Google interoperability (code shared with S3, **untested**, unusable until its test passes); Azure Blob outbound (**not implemented**) | `nas-protection` |
| NAS → NAS replication | Tested, **same host only** (no second physical/VM appliance exists) | `nas-protection` |
| Physical hardware deployment (SOW 36A.2) | **Not done** | — |
| Real-time cross-site failover | Not built (test failover and promotion of a replica on the same host are) | — |

## 3. Running it

Environment (`.env.local` / deployment env): `MONGODB_URI`, `NAS_ENCRYPTION_KEY`
(32 random bytes, base64 — encrypts appliance and cloud-target secrets),
`CRON_SECRET` (for `/api/cron/nas`). Optional: `NAS_WSL_DISTRO` (default
`Ubuntu`), `NAS_AGENT_MANAGED_UPDATES=1` (production: never auto-install a newer
agent; use the guarded update flow), `NAS_WSL_KEEPALIVE=0` to disable the
keep-alive.

**Where the control plane must run.** It has to be able to run the appliance
agent, so it runs on (or next to) the appliance host. The hosted website
(Vercel) cannot reach a NAS on a customer's network; the NAS console there
would show every appliance unreachable. Do not put the NAS worker in
`vercel.json`.

**Worker.** `node --env-file=.env.local scripts/nas-worker.mjs` (loop, 60 s) or
`GET /api/cron/nas` with `Authorization: Bearer $CRON_SECRET`. One pass queues
due snapshots, threat scans, replications and backups as idempotent jobs, lifts
expired locks and lockdowns, purges recycle bins, re-checks NAS accounts against
organization memberships, checks quota states, and runs the jobs.

**WSL2 idle behaviour.** WSL2 stops its VM when idle, which unmounts pools and
stops Samba/NFS. The worker starts a keep-alive `sleep`. Independently, the
agent's first call after any restart re-attaches loop devices, re-assembles
mirrors, mounts pools/quota volumes and starts services (measured in the
report). A physical appliance does not have this problem.

## 4. Security defaults

* No default public exposure: SMB access is limited by `hosts allow` per the
  remote-access mode; only private/loopback/link-local networks are accepted;
  NFS exports must list explicit client networks (`*` and `/0` rejected) and use
  `root_squash`.
* Every appliance operation is a validated JSON request to the agent (no shell
  strings); all paths must resolve inside the NAS root (symlink and `..`
  escapes are rejected); file names with control characters are excluded from
  manifests and counted.
* Samba bad-password lockout is configurable per appliance; management access
  is protected by the Inaya sign-in.
* Every consequential action is audited through the organization's existing
  cryptographic audit chain, with evidence rows whose hashes the chain commits
  to.

## 5. Recovery runbook (SOW 36A.4)

| Situation | What to do |
|---|---|
| **Failed agent update** | The update flow rolls back automatically if post-checks fail (previous copy kept as `/usr/local/sbin/inaya-nas-agent.py.prev`). Manually: `wsl -d Ubuntu -u root -- cp -f /usr/local/sbin/inaya-nas-agent.py.prev /usr/local/sbin/inaya-nas-agent.py`, then Updates → history. A configuration backup is stored under `/var/lib/inaya-nas/config-backups/` before each update |
| **Samba/NFS service down** | Overview shows "File sharing is not running". Any agent call runs `ensure_online` after a restart; otherwise `service smbd start`, `service nfs-kernel-server start`. Local data is unaffected |
| **Appliance VM will not start** | `wsl --shutdown`, start the distro again; the first agent call re-mounts everything. Data is in `/var/lib/inaya-nas/pools/*/disk*.img` and `/srv/inaya-nas` — back these up with `wsl --export` |
| **Failed data disk in a mirror** | Pool shows DEGRADED (Overview → CRITICAL). Data stays readable and writable. Pools → *Replace disk & rebuild*. A second failure before the rebuild finishes loses the pool — RAID is not backup |
| **Failed / lost pool** | Restore each share from the latest recovery point (Backup → Restore copy, or restore from a replica: Replication → failover). Create a new pool first |
| **Corrupted data detected** | Pools → *Scrub*. Checksum errors are counted; a corrupted file returns an error rather than bad bytes. Restore that file from a snapshot or backup |
| **Ransomware suspected** | Security → threat event. An immutable protective snapshot exists already; approve the lockdown if recommended; restore from the *last clean snapshot* the event points to (into `.restored/` first), then mark the event contained |
| **Lost management credentials** | Management is your Inaya organization sign-in; recover through the normal account recovery. Appliance-side Samba passwords are rotated from Users & Groups |
| **Lost connectivity to Inaya (control plane)** | Local file access continues. Overview shows the appliance cannot reach Inaya; cloud-dependent jobs queue as RETRYING and resume automatically. Nothing is lost |
| **One cloud target unavailable** | Backup runs to that target fail visibly (health on Cloud Targets); other targets are unaffected; retry resumes from the run's checkpoint |
| **Loss of the appliance itself** | Rebuild an appliance, register it, restore shares from Inaya backup recovery points (Backup → Restore, or to an alternate share) or promote a replica |
| **Locked account** | Users & Groups → Unlock (clears Samba's lockout flag) |

## 6. Optional capabilities evaluated (SOW 34–36)

* **iSCSI** — evaluated. This kernel loads the LIO target modules (`target_core_mod`, `iscsi_target_mod`) and has configfs, so a target is *possible*, but no supported target stack (`targetcli-fb`) is installed, and the SOW says not to add iSCSI for feature parity. No customer use case (VM datastores, databases) has been established. Classified **FUTURE**; not implemented, not claimed. The agent's `iscsi_probe` op records the evaluation.
* **Local S3 gateway** — not implemented. It would need a local object store with the same ACL/encryption/audit controls; Inaya's existing S3-compatible API already serves the sovereign cloud path. Classified **FUTURE**.
* **Kubernetes CSI** — not implemented (SOW: only with a real use case and production-ready semantics). **FUTURE**.
