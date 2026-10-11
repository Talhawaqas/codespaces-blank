---
slug: infrastructure-nodes
title: Infrastructure Nodes
description: How a physical or virtual Linux host joins your organization's infrastructure cluster, and what happens after it does.
product: Infrastructure
category: guide
contentType: Product Guide
audience: [infrastructure-admin, security-team]
status: beta
version: current
tags: [infrastructure, nodes, enrollment, certificates]
lastVerifiedAt: "2026-10-11"
relatedDocs: [infrastructure-overview, security-layer]
---

## What a node is

A node is one Linux host — physical or virtual, yours or on your premises — running the `inaya-infra-node` agent. Each node has its own unique cryptographic identity; there is no shared secret between nodes.

## Joining a cluster

1. An organization administrator creates a cluster and mints a one-time enrollment token, valid for 30 minutes.
2. On the host that will become a node, run `inaya-infra node enroll --control-plane-url <your control plane> --token <the token> --data-dir <a persistent directory>`.
3. The node generates its own private key locally — it is never sent anywhere — and submits a certificate signing request along with the enrollment token.
4. The control plane verifies the token, issues a real signed certificate under your cluster's own certificate authority, and records the node as **PENDING**.
5. An administrator approves the node (`POST /api/orgs/infrastructure/nodes/{nodeId}/approve`) to move it to **ACTIVE**.

The enrollment token can only be used once. A reused or expired token is rejected.

## After joining

An active node runs `inaya-infra-node` as a standing daemon, sending a signed heartbeat with its real current CPU, memory, and runtime-version information on a regular interval. If a node stops sending heartbeats, it eventually reads as **UNAVAILABLE** rather than silently appearing healthy forever.

## Revoking a node

An administrator can revoke a node's certificate at any time (`POST /api/orgs/infrastructure/nodes/{nodeId}/revoke`). A revoked node's every further request — heartbeat or otherwise — is immediately refused, and this cannot be undone by the node itself.

## Diagnostics

Run `inaya-infra doctor` (or `inaya-infra node status` for a node that has already enrolled) on any Linux host to check whether it's ready to join a cluster: hardware virtualization support, access to the KVM device, QEMU presence, available memory and disk, and basic networking tools. Every check reports a real, independently verifiable fact about that host.

## What's not here yet

Running actual virtual machines on a node, attaching real disks, and virtual networking are not part of node enrollment itself — those are separate capabilities, not yet available. Enrollment and heartbeat only establish that a node exists, is trusted, and is alive.

## Related

- [Sovereign Infrastructure Fabric — Overview](/docs/products/infrastructure-overview)
