---
slug: s3-compatible-storage
title: S3-Compatible Storage
description: Use Inaya through a real, tested S3-compatible API — verified against the AWS CLI, rclone, Terraform, and the AWS SDK.
product: Storage
category: guide
contentType: Product Guide
audience: [developer, enterprise-it, cloud-migration-team]
status: live
version: current
tags: [s3, storage, aws, azure, google-cloud, migration]
lastVerifiedAt: "2026-09-21"
relatedDocs: [storage, storage-control-plane, inaya-drive]
---

## Overview

Inaya exposes real, request-signature-verified S3, Azure Blob, and Google Cloud Storage-compatible endpoints on top of the same encrypted, sharded storage pipeline described in [Inaya Storage](/docs/products/storage). This is not a marketing label — it's tested against real, unmodified third-party clients.

## What's real and verified

- Real **AWS SigV4** (AWS4-HMAC-SHA256) and native **Google Cloud Storage GOOG4-HMAC-SHA256** request signing on one endpoint.
- Real **Azure Blob Shared Key** compatibility, plus Microsoft Entra ID identity federation.
- Temporary signed download URLs with real, tested expiration (including waiting for genuine wall-clock expiration, not a simulated clock) and tamper rejection.
- Virtual-hosted bucket addressing, off by default until an operator configures it.
- Object tags, an independently-verifiable checksum on every upload, storage inventory export (JSON/CSV), bulk tag/retention/legal-hold operations across up to 1,000 objects, per-bucket storage analytics, and a read-only storage-credential policy analyzer.
- Validated against real, unmodified third-party tools: the **AWS CLI**, **rclone**, **Terraform** (`hashicorp/aws` provider — a real `init → apply → plan → destroy` lifecycle, including `force_destroy` actually emptying a bucket), and Google's own **gcloud storage** CLI. AzCopy is honestly classified unsupported today — it requires SAS-token or Entra ID auth for Azure Blob, which this layer's Shared-Key-only implementation doesn't yet provide.

## The one honest trust-model difference

Ordinary S3/Azure/GCS clients (`aws s3 cp`, AzCopy, boto3) upload and expect plaintext bytes over TLS — they never encrypt client-side. So objects written through this compatibility layer are encrypted **server-side**, under a key scoped to the organization's own compatibility-layer credential, not the zero-knowledge, browser-only key used elsewhere on Inaya. Every document created this way carries a real, visible `encryptionMode: "server-managed"` flag, distinct from the implicit client-managed model everywhere else — this trust-model distinction is never left ambiguous in the UI or the docs.

## Getting a credential

An org owner/admin issues a real Access Key ID / Secret Access Key pair from the S3-Compatible Storage tab in Business Workspace. The secret is shown exactly once at creation, the same discipline used for org API keys.

## Migrating existing data in

A local, standalone Data Migration Agent moves existing AWS S3, Azure Blob, or Google Cloud Storage data into Inaya — resumable if interrupted, with byte-level integrity verification, and every source credential staying on the operator's own machine (never sent to or stored by Inaya).

## Related

- [Inaya Storage](/docs/products/storage)
- [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane)
- [Inaya Drive](/docs/products/inaya-drive)
