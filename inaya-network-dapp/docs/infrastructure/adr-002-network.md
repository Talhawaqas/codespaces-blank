# ADR-002: Virtual network provider — Linux bridge + nftables (Phase 1), OVN deferred

Status: Accepted, 2026-10-10.

## Context

§300 asks for an evaluation before committing to OVN as the SOW's own candidate technology (§28). The target is real VPC/subnet/security-group semantics: VMs get private IPs, security groups actually block/allow traffic, and no VM can reach another tenant's network (§64, §216).

## Options evaluated

| Option | Verdict |
|---|---|
| **OVN/OVS** | Correct long-term choice for multi-host VPC/overlay networking at scale, but it is a distributed system in its own right (a northbound/southbound database, `ovn-controller` per host, Geneve/VXLAN overlays between hosts). Standing it up *correctly* — not just running — inside a single nested-virtualization environment (WSL2 and/or WSL-cloned instances) carries real risk of producing something that looks configured but isn't genuinely verified, which §345/§328 explicitly forbid presenting as working. |
| **Linux bridge + nftables (chosen for Phase 1)** | Each VPC maps to a Linux bridge; each subnet to an IP range on that bridge; each VM's tap interface attaches to its VPC's bridge; security groups compile to per-interface nftables rules (ingress/egress, stateful). This is standard, well-understood, genuinely testable today in WSL2 (bridges and nftables both work in an unprivileged-enough container/VM context), and gives real, verifiable VPC isolation and security-group enforcement — not a placeholder. |
| **Pure userspace overlay (e.g. a custom VXLAN mesh)** | Rejected — reinvents what OVN already solves properly; not justified until the bridge-based model is proven and multi-host overlay is actually needed. |

## Decision

Phase 1 ships a real `NetworkProvider` implementation backed by Linux bridges + nftables, single-host scope (all VMs on one physical/virtual node, or VMs on nodes within the same L2 segment for the WSL-clone multi-node test). This genuinely satisfies §216's acceptance criteria (VPC created, subnet works, VM receives IP, security group controls access, blocked traffic is actually blocked, cross-tenant networking is impossible) without an unverified OVN deployment.

OVN remains the **documented future path** for cross-host overlay networking once a real multi-physical-host deployment exists to test it against (§889 — "final provider must be selected after Phase 0" is satisfied by this evaluation; nothing here forecloses adopting OVN later).

## Consequences

- `inaya-infrastructure/crates/network` defines a `NetworkProvider` trait (§189) so OVN can be added later as a second implementation without touching the control-plane API.
- Load balancing (§35) and DNS/service discovery (§36) are explicitly **not** built on top of this in Phase 1 — both are named future work in the SOW itself (§1001, §1037) and depend on decisions (HAProxy/NGINX; CoreDNS vs. OVN-native discovery) this ADR doesn't need to make yet.
- Cross-host networking (a VM on node A reaching a VM on node B in the same VPC) is scoped only as far as this environment's multi-node substrate (WSL-cloned instances or VirtualBox VMs, see the implementation ledger) genuinely supports testing it — anything beyond that is marked `NOT TESTED`, not claimed.
