---
slug: infrastructure-overview
title: Sovereign Infrastructure Fabric — Overview
description: A customer-owned physical compute, network, and block-storage layer underneath Inaya's existing enterprise platform — bare metal you control, not a second cloud.
product: Infrastructure
category: concept
contentType: Product Guide
audience: [enterprise-it, security-team, infrastructure-admin]
status: beta
version: current
tags: [infrastructure, compute, kvm, qemu, nodes, sovereign]
lastVerifiedAt: "2026-10-11"
relatedDocs: [business-workspace, security-layer]
---

## What it is

The Sovereign Infrastructure Fabric is a customer-owned physical infrastructure layer — compute (virtual machines), block storage, and virtual networking — that runs on hardware you control, not a shared Inaya data center. It closes a real, previously-documented gap: Inaya's storage control plane has always been able to describe a "volume," but had nothing underneath it a block device could physically attach to until now.

This is **not** a second cloud and **not** a fork of any third-party project. It's an independently built runtime, modeled on sovereign-infrastructure principles (customer-owned bare metal, edge deployment, offline operation), that plugs into Inaya's existing identity, audit, evidence, and trust systems rather than duplicating any of them.

## What's live today

- **Node enrollment**: a real Linux host (Phase 1 target: any host with hardware virtualization — KVM on Linux) joins your organization's infrastructure cluster through a one-time enrollment token, proves possession of a freshly generated private key via a certificate signing request, and receives a real signed certificate issued by your cluster's own certificate authority. No universal static secrets — every node's identity is unique and individually revocable.
- **Heartbeat and real capacity reporting**: an enrolled node reports its actual CPU count, memory, kernel version, and QEMU version on a regular interval. Nothing here is a placeholder number — it's read directly from the host.
- **`doctor` diagnostics**: a real readiness check (hardware virtualization support, KVM device access, QEMU presence, memory, disk space, networking tools) a node operator can run before or after joining a cluster.
- **Revocation**: an administrator can revoke a node's certificate at any time; a revoked node is immediately refused for every further request.

## What's not live yet

- Actually running virtual machines, attaching real disks, and virtual networking (compute/block/network providers) — these are the next phases of work and are not available yet.
- A Business Workspace console page to view and manage nodes visually — today, nodes are managed via the API and CLI only.
- Multi-node clustering and high availability.
- GPU allocation. Hardware *detection* is planned; actual GPU passthrough requires a bare-metal host that directly owns the GPU device, which most laptops and virtualized dev environments cannot provide — this will be verified against real hardware before any passthrough claim is made.

## Honest architecture note

Node-to-control-plane communication is authenticated over plain HTTPS using a request-signing scheme (the node signs a short-lived token with its own certified private key; the server verifies it against the node's certificate) rather than literal TLS-layer mutual authentication — the platform this control plane runs on doesn't expose custom client-certificate verification to its API routes. The cryptographic guarantee is the same: proof that the caller holds the private key matching a certificate the server trusts.

## Related

- [Security Layer](/docs/products/security-layer)
- [Business Workspace](/docs/products/business-workspace)
