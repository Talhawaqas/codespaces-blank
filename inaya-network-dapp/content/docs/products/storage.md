---
slug: storage
title: Inaya Storage
description: Client-side encryption, binary sharding, and DePIN-backed custody for every file stored on Inaya.
product: Storage
category: concept
contentType: Product Guide
audience: [developer, enterprise-it, security-team]
status: live
version: current
tags: [storage, encryption, sharding, custody]
lastVerifiedAt: "2026-09-21"
relatedDocs: [s3-compatible-storage, storage-control-plane, inaya-drive]
---

## Overview

Inaya Storage is the foundation every other storage-facing product on the platform is built on top of: S3/Azure/GCS compatibility, Inaya Drive, the Storage Control Plane, and Business Workspace Documents all read and write through the same underlying pipeline described here.

## How a file is actually protected

1. **Client-side encryption.** A file is encrypted with AES-256-GCM before it ever leaves the client. The encryption key is derived with PBKDF2 from the user's own credential (a passkey for the wallet-based flow, or an org-scoped key for the S3-compatible layer — see [S3-Compatible Storage](/docs/products/s3-compatible-storage) for how that specific trust model differs).
2. **Binary sharding.** The encrypted ciphertext is split into shards (`disperseAndSlice()` in `@inaya-network/custody-sdk`'s `crypto.js` layer) rather than stored as one object.
3. **DePIN custody and redundancy.** Shards are pinned across independent providers with dual-provider replication and automated health monitoring, so a single provider's failure doesn't threaten a file's recoverability.
4. **Recovery.** A real, tested simulated-failure-to-recovered cycle exists for the backup/redundancy path (`InayaBackupRegistry`, on-chain).

## What "not even Inaya can peek inside" means, precisely

For the wallet-based zero-knowledge flow, the encryption key never leaves the browser and is never stored server-side. This guarantee is structurally different for the S3-compatible storage layer, which encrypts server-side under an org-scoped key so that ordinary S3/Azure/GCS clients (which never encrypt client-side themselves) can work against it — this distinction is documented plainly, not glossed over, on the [S3-Compatible Storage](/docs/products/s3-compatible-storage) page.

## Related

- [S3-Compatible Storage](/docs/products/s3-compatible-storage)
- [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane)
- [Inaya Drive](/docs/products/inaya-drive)
