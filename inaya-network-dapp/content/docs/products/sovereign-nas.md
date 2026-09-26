---
slug: sovereign-nas
title: Sovereign NAS
description: Real network storage (SMB and NFS) for your office, connected to Inaya's encrypted cloud storage, verified backup and recovery, ransomware response, evidence and What-If simulation.
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, business-admin, auditor]
status: live
version: current
tags: [nas, smb, nfs, backup, snapshots, ransomware, recovery]
lastVerifiedAt: "2026-09-25"
relatedDocs: [business-workspace, s3-compatible-storage]
---

## What it is

Inaya Sovereign NAS turns a Linux machine on your own network into real file storage that Windows, Linux and NFS clients use like any other network drive, and connects it to the rest of Inaya: encrypted backup to Inaya storage, tested restores, tamper-evident records of every important action, and a What-If simulator. The file service works on its own — it does not need the Inaya cloud to be reachable.

A dashboard that only shows disk statistics is not a NAS. Here, creating a share creates a real Samba share; a quota is enforced by the filesystem; a snapshot is a real copy-on-write snapshot; "immutable" means deletion is technically blocked.

## What you can do

| Area | What it gives you |
|---|---|
| Storage pools | RAID1 mirrors (or single disks) on Btrfs with checksums; a failed disk leaves the pool degraded but readable and writable, and a replacement rebuilds it |
| Shares | SMB shares (and NFSv4 exports for named networks) with recycle bin, rename, hide, disable |
| Access | Per-share read/write/deny for people and groups, folder-level permissions, enforced by the file server itself; access follows your organization — someone who loses NAS access is locked out on the appliance |
| Quotas | Hard limits that really stop writes (Btrfs and quota volumes), per-user limits on quota volumes; warning, near-limit, limit and full states with alerts |
| Snapshots | Manual and scheduled; optional **immutable** snapshots with a retention period; restore a file or a whole share side-by-side or in place |
| WORM | Write-once protection: files can be added but not changed or deleted until retention ends |
| Backup | To Inaya sovereign storage or an S3-compatible provider; unchanged files are skipped; everything is read back and verified; resumable after a failure |
| Recovery | Restore to the original share, another share, or as object references; **test restores** prove a backup can actually be recovered |
| Replication | NAS-to-NAS with verification, test failover (read-only) and promotion |
| Ransomware response | Detects mass rewrites, ransom notes, mass deletion and repeated failed logons; takes an immutable snapshot, alerts managers, and recommends (or, if you enable it, applies) a temporary read-only lockdown |
| Tiering | Proposes moving old files to Inaya; a different manager must approve; the copy is verified first; fully reversible |
| Evidence | Every consequential action is written to your organization's cryptographic audit chain; a sealed state commitment lets an auditor confirm the NAS still matches what Inaya recorded |
| What-If | Simulate a NAS outage, a disk failure, ransomware, an employee losing access, or the NAS reaching 95% full — without touching the live NAS |

## Honest limits

- The supported deployment profile is a **virtual appliance** (a Linux VM). It has **not** been run on physical hardware, so physical disk health (SMART), temperature and UPS data are shown as UNKNOWN rather than invented.
- "Immutable" and WORM are governance-grade: they stop users, ransomware and compromised share logins; someone with root on the appliance itself could still lift the flag.
- Replication between two NAS appliances works, but with one machine available it was tested with both appliances on the same host. Machine-to-machine transport is not implemented.
- Google Cloud Storage interoperability targets are untested and unusable until they pass their own connection test; Azure Blob is not available as an outbound target.
- Active Directory / LDAP are not implemented; iSCSI, a local S3 gateway and Kubernetes CSI are not implemented.
- macOS clients have not been tested.
- The NAS control plane must run next to the appliance; the hosted website cannot reach a NAS on your private network.
- This is not a compliance certification. No HIPAA, ISO, SOC or FedRAMP claim is made.
