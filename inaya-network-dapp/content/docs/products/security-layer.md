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
tags: [security, threat-registry, node-reputation]
lastVerifiedAt: "2026-09-21"
relatedDocs: [business-workspace]
---

## Overview

The Security Layer ("Inaya Firewall") is a decentralized threat-intelligence network: node operators report observed threats, and confirmation is reputation-weighted rather than trusting any single reporter — a public feed, not one company's private blocklist.

## What's live

- Node-reported threat indicators with a real on-chain reputation system for reporters.
- A public Security transparency page and a Security AI Assistant, on both web and mobile.
- A mobile Security screen — protection mode, destination checker, allow/blocklist.
- In-app wallet-attack protection — the threat registry wired directly into the cross-chain Bridge's recipient-address field, with live threat warnings before you send.
- A Desktop OS-level firewall enforcement layer (Windows/Linux) — built and code-reviewed, but not yet verified on real hardware, so it's stated as such rather than claimed live.

## Report a threat

Any registered node operator can submit a signed observation via the `@inaya-network/node-daemon` CLI — see the [node-daemon CLI reference](/docs/cli/node-daemon).

## Related

- [Business Workspace](/docs/products/business-workspace)
