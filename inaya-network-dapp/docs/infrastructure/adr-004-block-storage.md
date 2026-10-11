# ADR-004: Physical block storage — raw/qcow2 image files over virtio-blk

Status: Accepted, 2026-10-10.

## Context

§23/§301 ask for an evaluated choice. This is the literal gap `storageResources.js` names: "no VM/hypervisor runtime exists in Inaya to attach a real block device to." The provider must give a VM a real, persisting, snapshot-capable disk.

## Options evaluated

| Option | Verdict |
|---|---|
| **Local NVMe (raw partition/LUN passthrough)** | Fastest possible, but ties a volume permanently to one physical device with no software-level snapshot/move capability — wrong fit for a control plane that needs to create/delete/snapshot volumes on demand. |
| **LVM (logical volumes + thin provisioning + snapshots)** | A real, mature option with native snapshot support; deferred as a documented future backend rather than Phase 1's default, since it requires host-level LVM setup/privileges beyond what's needed to prove the provider abstraction works correctly first. |
| **Raw/qcow2 sparse image files on the host filesystem, attached via `virtio-blk`** (chosen) | Simplest path to something genuinely real: a sparse file is a real block device from the guest's perspective once attached via QEMU's `virtio-blk-pci`, it persists correctly across VM stop/start, `qcow2`'s native snapshot format gives real point-in-time snapshots without inventing a snapshot format, and nothing here is simulated — the guest OS genuinely reads and writes real bytes on a real host filesystem. |
| **NBD (network block device)** | The right shape for a future distributed/replicated backend (§26 — `replicationFactor`/`primaryNode`/`replicaNodes[]`), explicitly deferred until single-node correctness is proven. |
| **A custom distributed block backend** | Far out of scope for Phase 1; not evaluated further — §26 itself frames this as "future." |

## Decision

Phase 1-3: `BlockStorageProvider` backed by sparse raw/qcow2 files on the node's local filesystem (WSL2's own ext4 in this environment; any Linux filesystem on real hardware), attached to guests via `virtio-blk`. Real acceptance per §215: created → attached → written → persisted → detached → reattached → snapshot created → restored, with genuine data integrity, not a logical-only record.

## Consequences

- `inaya-infrastructure/crates/block` defines the `BlockStorageProvider` trait (§23) with this as the first real implementation — `createVolume`, `deleteVolume`, `attachVolume`, `detachVolume`, `snapshotVolume`, `restoreVolume`, `getVolume`.
- Volume state machine (§24: `CREATING → AVAILABLE → ATTACHING → IN_USE → DETACHING → RESTORING → DELETING → DELETED`, plus `DEGRADED`/`FAILED`/`UNKNOWN`) uses atomic compare-and-set on the control-plane side (§25/§143) to prevent double-attachment — enforced in the Next.js API layer against MongoDB, not just in the Rust node agent.
- A physical snapshot references the existing logical storage-resource identity in `storageSnapshots.js` (§27) rather than creating a second snapshot registry — the physical bytes live with the node's qcow2 backing files; the control plane's `storageSnapshots.js` record is extended with a pointer to which node/path holds the physical snapshot.
- LVM/NBD/distributed replication remain documented future backends behind the same trait — switching or adding one later does not change the control-plane API (§12's "future providers must be possible without redesigning the Business Workspace API" applies equally to block storage).
- Encryption: `LUKS/dm-crypt` where compatible, per §188 — evaluated in Phase 3's implementation, not invented as a proprietary format.
