# Sovereign Infrastructure Fabric — architecture

## Layer model (§4)

```
┌─────────────────────────────────────────────────────────────┐
│                 INAYA SOVEREIGN ENTERPRISE OS               │
├─────────────────────────────────────────────────────────────┤
│ Business: Finance / HR / Health / Legal / Government / CRM  │   <- unchanged, existing
├─────────────────────────────────────────────────────────────┤
│ AI: OS Assistant / Bookkeeper / ML Studio / Digital Twin    │   <- extended (Phase 7)
├─────────────────────────────────────────────────────────────┤
│ Trust: Identity / Permissions / Audit / Evidence / Policy  │   <- extended (Phase 7)
├─────────────────────────────────────────────────────────────┤
│ Data: S3 / Drive / DirectSync / NAS / Backup / Snapshots   │   <- unchanged, existing
├─────────────────────────────────────────────────────────────┤
│ Infrastructure: Compute / Network / Block / GPU / DNS      │   <- NEW, this SOW
├─────────────────────────────────────────────────────────────┤
│ Physical: Bare Metal / Private DC / Edge / Air-Gap         │   <- NEW, this SOW
└─────────────────────────────────────────────────────────────┘
```

## Request path (§7)

```
Browser / SDK / Terraform / CLI
                │
                ▼
      Next.js Infrastructure API   (src/app/api/orgs/infrastructure/*, src/app/api/public/v1/infrastructure/*)
      — identity, policy, evidence, billing planes; NOT the hypervisor
                │
                ▼ (NATS, mTLS)
         Message Fabric            (NATS + JetStream, ADR-003)
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
   inaya-infra-node (one per customer host — Rust daemon)
       │
     QEMU/KVM (ComputeProvider), virtio-blk images (BlockStorageProvider),
     Linux bridge + nftables (NetworkProvider)
       │
     Customer Hardware
```

The Next.js application is explicitly the business/identity/policy/evidence/billing control plane — never the hypervisor (§7). Every physical action (a VM actually starting, a disk actually attaching) happens inside `inaya-infra-node`, on the customer's own host, authenticated by mTLS node identity, dispatched over NATS. The control plane only ever holds **desired state**; `inaya-infra-node` reports **observed state** back, and the reconciler (Phase 5) is the only thing allowed to notice and surface drift between the two (§78).

## Two provider models (§9)

- `INAYA_NATIVE` — the customer runs `inaya-infra-node` on their own hardware, this SOW's actual build target.
- `EXTERNAL_PROVIDER` — an optional, strictly separate adapter (`ExternalComputeProvider`, §247) that could one day talk to a customer's own Spinifex deployment over its public network API. Not built in this pass (no customer has asked for it); the trait exists so it's possible later without redesigning anything. Never imports Spinifex source — talks to it over the wire exactly like any other external provider, same as `rds/providers/supabase.js` talks to Supabase.

## Rust workspace (ADR-001)

```
inaya-infrastructure/
├── Cargo.toml
├── crates/
│   ├── inaya-infra-cli/     # cluster init/join/status/upgrade, node/compute/volume/network commands, doctor (§131)
│   ├── inaya-infra-node/    # the node agent daemon (§40) — binary entrypoint
│   ├── cluster/             # membership, leases (§108), scheduler (§47-48, §91-92), reconciliation (§75)
│   ├── compute/             # ComputeProvider trait (§12) + QEMU/KVM implementation
│   ├── network/             # NetworkProvider trait (§189) + Linux bridge/nftables implementation (ADR-002)
│   ├── block/                # BlockStorageProvider trait (§23) + raw/qcow2 implementation (ADR-004)
│   ├── messages/              # async-nats wrapper, subject naming (§38), message metadata envelope (§39)
│   ├── certificates/           # mTLS enrollment (§42), node identity (§41), revocation (§43)
│   ├── security/                 # guest isolation (§62), QMP restriction (§63), parameterized process exec (§61)
│   ├── telemetry/                  # capacity/health reporting (§15, §126)
│   └── api-types/                   # shared request/response structs, kept in lockstep with docsApiReference.js
├── tests/                        # integration tests — real QEMU, real NATS, real multi-node where the environment allows
├── packaging/                     # systemd units (§137), installer scripts (§57, §225)
└── docs/
```

## Control/data plane separation (§244)

| Management plane (Next.js) | Data plane (`inaya-infra-node`) |
|---|---|
| identity, policy, billing, desired state, evidence | VM execution, packets, storage I/O, local runtime |

The two are not tightly coupled: a WAN outage between them does not stop an already-running workload (§243, §52) — this is exercised for real in Phase 6 by disconnecting the WSL2 node's network interface and confirming the running QEMU process is unaffected.

## Differences from the current Inaya storage model

`storageResources.js`'s `"volume"` is a **declared** resource — a reservation record backed by an S3-compatible bucket, explicitly never claiming real physical attachment. This SOW's `COMPUTE_INSTANCE`/`VOLUME`/`VPC` resources are **genuinely physical** — backed by a real `inaya-infra-node` actually running QEMU, actually writing bytes to a real disk image. This is a deliberate, documented exception to the "declared, not physical" precedent the storage audit set — it's the entire point of this SOW, not an accidental inconsistency.
