---
slug: developer-overview
title: Developer Overview
description: Everything you need to build on Inaya — five real, published packages, a real S3-compatible storage API, and a real Terraform provider.
product: Developer Platform
category: concept
contentType: Concept
audience: [developer, web3-developer, integration-partner]
status: live
version: current
tags: [sdk, cli, developer]
lastVerifiedAt: "2026-09-21"
relatedDocs: [storage-control-plane]
---

## Five real, published packages

| Package | What it's for |
|---|---|
| `@inaya-network/custody-sdk` | The core client SDK — encrypt, shard, and anchor files. |
| `@inaya-network/react` | Drop-in React + Tailwind components (`InayaConnect`, `InayaUploader`, `InayaFileBrowser`). |
| `inaya-cli` | Encrypt/shard/anchor files from a terminal or CI/CD pipeline. |
| `create-inaya-dapp` | Scaffold a new Next.js app pre-wired with the SDK, React components, Tailwind, and wagmi/viem. |
| `@inaya-network/node-daemon` | Register and run an Inaya node operator. |

Full reference for each: [SDK Reference](/docs/sdk), [CLI Reference](/docs/cli).

## A separate cross-chain SDK

`@inaya-network/bridge-sdk` is deliberately a separate package from `custody-sdk` — cross-chain transfer and staking is a distinct concern from file custody, so upload-only consumers don't pay for a surface they don't use.

## The public API

`/api/public/v1/*` — evidence lookup, audit-chain verification, permission checks, and the full storage control plane (resources, snapshots, backup policies/plans). Every request authenticates with a bearer org API key. Full reference: [API Reference](/docs/api).

## Infrastructure as code

`terraform-provider-inaya` lets you declare storage volumes, snapshots, and backup policies as Terraform resources. See [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane).

## 30-second quickstart

```bash
npm install @inaya-network/custody-sdk ethers
```

```js
import { connectWallet, generateSecureSalt, deriveVaultKey, disperseAndSlice, anchorToLedger } from "@inaya-network/custody-sdk";

const wallet = await connectWallet();
const salt = generateSecureSalt();
const vaultKey = await deriveVaultKey(wallet, salt);
const shards = await disperseAndSlice(fileBuffer, vaultKey);
await anchorToLedger(shards, wallet);
```

See [inayanetwork.com/build](/build) for the fuller walkthrough and value proposition.

## Related

- [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane)
