# How this differs from Spinifex

Per §341/§347. Inaya's Sovereign Infrastructure Fabric is **independently authored**, not a fork, port, or derivative of Spinifex (`github.com/mulgadc/spinifex`, AGPL-3.0). No Spinifex source was read line-by-line and translated; the only inputs used were its publicly documented architecture (its `DESIGN.md`) and its publicly listed feature surface, used the same way any engineering team researches a category before building their own implementation — never copied.

## What's genuinely similar (architectural principles, not code)

Both systems share the same high-level shape because both solve the same problem (bare-metal infrastructure for sovereignty-conscious customers): QEMU/KVM for compute, a message-driven control plane, separated compute/network/block-storage concerns, edge/offline operation, AWS-compatible interoperability where genuinely tested. These are industry-standard patterns for this problem space, not Spinifex-specific inventions.

## What's different, and why

- **Enterprise identity** — Inaya's infrastructure layer sits on top of an existing, mature org/membership/SCIM/AD-LDAP identity system (`src/lib/identity/*`, `orgGates.js`) that predates this SOW by months. Spinifex has no equivalent breadth; Inaya's infrastructure gates (`canAccessInfrastructure`) are additive fields on an identity model that already handles enterprise SSO.
- **Evidence Graph** — every infrastructure resource (a compute instance, a volume, a VPC) becomes a traceable node in Inaya's existing Evidence Graph (`businessEvents.js`), connected to the business records that depend on it. Spinifex has no equivalent concept.
- **Digital Twin** — Inaya's existing dependency-graph simulation (`digitalTwin.js`) extends to answer "what happens if node-02 fails" against real stored relationships, not a hypothetical. No Spinifex equivalent.
- **AI guarded execution** — any AI-proposed infrastructure change (even read access, for destructive actions) goes through Inaya's existing `PENDING_APPROVAL → APPROVED → QUEUED → EXECUTED` pipeline (`ai-action-requests.js`), with a mandatory human-approval delay. Spinifex has no AI layer at all.
- **Regulated verticals** — Healthcare/Financial/Government/Legal policy inheritance (§236-240) rides Inaya's existing vertical-lock infrastructure, built for entirely different business modules (Health records, Legal matters) long before this SOW existed.
- **Existing S3/Azure compatibility, resilience, enterprise workflows** — all reused as-is (see `capability-audit.md`), not rebuilt to match Spinifex's own storage/resilience approach.

## What's deliberately not claimed

This document exists specifically so Inaya never represents itself as "Spinifex inside Inaya," and conversely never claims feature parity with Spinifex's own mature, specific implementations (its exact OVN tuning, its exact erasure-coding object store, its exact k3s integration) that this SOW explicitly does not attempt to replicate wholesale — see `IMPLEMENTATION-LEDGER.md` for precisely which Spinifex-documented capabilities are built, deferred, or not applicable to Inaya's architecture.
