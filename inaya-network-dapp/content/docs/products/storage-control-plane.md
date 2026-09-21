---
slug: storage-control-plane
title: Storage Control Plane & Terraform Provider
description: An IBM Cloud VPC Storage-inspired control panel for volumes, file shares, snapshots, and automated backup policies — plus a real Terraform provider.
product: Storage
category: guide
contentType: Product Guide
audience: [developer, enterprise-it, cloud-migration-team]
status: live
version: current
tags: [storage, terraform, snapshots, backup, infrastructure-as-code]
lastVerifiedAt: "2026-09-21"
relatedDocs: [storage, s3-compatible-storage]
---

## Overview

A control panel for a business's own Inaya storage, inspired by IBM Cloud's VPC storage product line: volumes and file shares as a real, organized registry; genuine point-in-time snapshots; and automated, tag-driven backup policies. Open it from the Business Workspace's Storage Control Plane tab.

## The one honest limit, stated plainly

IBM's "attachable hard drive" feature assumes a running virtual computer to plug it into. Inaya doesn't run virtual computers for customers, so a literal physical attach is not something this platform can build honestly. A `volume` (or `fileShare`) here is a real, taggable, resizable control-plane record backed by a real storage bucket, with a static `physicalCapability` field stating exactly this — it is never described as a physically attachable disk or a mountable NFS export.

## What's real

- **Storage resources.** Create a volume or file share, tag it, resize it (capacity only ever increases — a decrease is rejected, never silently ignored).
- **Attach/detach.** A real reservation/lock mechanism preventing two declared consumers from believing they own the same volume at once.
- **Snapshots.** Genuinely incremental at capture time (references existing object versions, no bytes copied), with an independently recomputable integrity hash. Restorable, copyable to a different resource, and shareable with another organization on a revocable, expiring grant. Consistency groups honestly disclose a sequential — not atomic — capture boundary.
- **Automated backup policies.** Select resources by tag, add a daily/weekly/monthly/long-term plan with a retention count, and Inaya's own hourly cron sweep runs due plans and enforces retention automatically — every deletion audited, never silent.

## terraform-provider-inaya

A real Go-based Terraform provider (`terraform-plugin-framework`), authenticated with an org API key against a bearer-token `/api/public/v1/storage/*` route namespace (see the [API Reference](/docs/api)).

```hcl
terraform {
  required_providers {
    inaya = { source = "talhawaqas/inaya" }
  }
}

provider "inaya" {
  endpoint = "https://app.inaya.network"
  api_key  = var.inaya_api_key
}

resource "inaya_storage_resource" "app_data" {
  type        = "volume"
  name        = "app-data"
  capacity_gb = 100
}
```

Resources: `inaya_storage_resource`, `inaya_snapshot`, `inaya_backup_policy`, `inaya_backup_plan`. Every attribute without a real backend update path (name, type, tags on a resource; a plan's frequency/retention) is `RequiresReplace` rather than silently no-opping a change the backend can't actually make.

**Status:** the provider's full create/read/update/delete cycle was tested against a real running deployment with real database state — not a dry run. It is not yet published to the Terraform Registry; build it locally from `terraform-provider-inaya/` in this repository and point Terraform at the binary with a `dev_overrides` config in the meantime.

## What's not built

Fast/accelerated restore (no backend primitive exists to make one honestly faster than a normal restore), real physical block-volume attach or real multi-client NFS mounting (structurally impossible without a compute layer Inaya doesn't have), and live interop validation against real IBM Cloud Object Storage (blocked on IBM Cloud account sign-up, not on anything left to build).

## Related

- [Inaya Storage](/docs/products/storage)
- [S3-Compatible Storage](/docs/products/s3-compatible-storage)
