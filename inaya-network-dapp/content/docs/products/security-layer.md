---
slug: security-layer
title: Security Layer
description: A decentralized, node-reported threat registry with reputation-weighted confirmation — public, not a single company's private blocklist.
product: Security
category: concept
contentType: Product Guide
audience: [security-team, developer, enterprise-it]
status: live
version: current
tags: [security, threat-registry, node-reputation, post-quantum, pqc]
lastVerifiedAt: "2026-10-10"
relatedDocs: [business-workspace, secure-collaboration]
---

## Overview

The Security Layer ("Inaya Firewall") is a decentralized threat-intelligence network: node operators report observed threats, and confirmation is reputation-weighted rather than trusting any single reporter — a public feed, not one company's private blocklist.

## What's live

- Node-reported threat indicators with a real on-chain reputation system for reporters.
- A public Security transparency page and a Security AI Assistant, on both web and mobile.
- A mobile Security screen — protection mode, destination checker, allow/blocklist.
- In-app wallet-attack protection — the threat registry wired directly into the cross-chain Bridge's recipient-address field, with live threat warnings before you send.
- A Desktop OS-level firewall enforcement layer (Windows/Linux) — built and code-reviewed, but not yet verified on real hardware, so it's stated as such rather than claimed live.

## Post-quantum key establishment (October 2026)

A hybrid post-quantum cryptography layer sits underneath device keys and encrypted sharing: every new key establishment combines the classical X25519 exchange already in use with an ML-KEM-768 (Kyber) encapsulation, derived together through a single domain-separated HKDF-SHA256 — never a bare concatenation of the two secrets. Losing either the classical or the post-quantum half alone does not break the result; an attacker needs both.

- Exposed through `custody-sdk`'s `Pqc` namespace (`wrapForRecipient`, `isAgileHybridEnvelope`, `capabilityInfo`) and `src/lib/pqc/deviceKeys.js` for per-device key registration, rotation, and revocation.
- Sharing envelopes are algorithm-agile (`LEGACY_CLASSICAL` / `HYBRID_PQC` / `PQC_REQUIRED`): existing classical-only shares keep working, and an organization can require the hybrid mode going forward without breaking older links.
- Revoking a device cascades to revoking that device's PQC keys — verified by an automated test, not just asserted.
- **Honest limit:** this is hybrid key *establishment*, not a claim that every downstream primitive (symmetric ciphers, signatures) is independently quantum-hardened. ML-KEM-768 is a NIST-standardized, audited, pure-JS implementation (`@noble/post-quantum`) rather than a custom one.

## Report a threat

Any registered node operator can submit a signed observation via the `@inaya-network/node-daemon` CLI — see the [node-daemon CLI reference](/docs/cli/node-daemon).

## Related

- [Business Workspace](/docs/products/business-workspace)
- [Secure Collaboration](/docs/products/secure-collaboration)
