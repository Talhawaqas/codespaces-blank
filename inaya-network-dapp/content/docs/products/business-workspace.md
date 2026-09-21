---
slug: business-workspace
title: Business Workspace
description: The organization, department, project, and document layer that every Business Operations module (Tasks, CRM, Procurement, Inventory, Finance, HR) builds on.
product: Business Workspace
category: concept
contentType: Product Guide
audience: [enterprise-it, business-workspace-admin]
status: live
version: current
tags: [business-workspace, organizations, permissions, documents]
lastVerifiedAt: "2026-09-21"
relatedDocs: [security-layer]
---

## Overview

Business Workspace is Inaya's SaaS-style layer on top of the core storage/encryption platform: organizations, departments, projects, documents, and a real role-based permission model, with a growing set of business-operations modules built directly on top of it rather than as separate products.

## Core structure

- **Organizations** — the top-level tenant. Sign-in is ordinary email/magic-link, independent of crypto wallets; a wallet is never required to use Business Workspace.
- **Departments and Projects** — the scoping unit most permissions are checked against (`canAccessDepartment`).
- **Documents** — org-wide file storage with per-document ACL/versioning, distinct from (but built on the same underlying pipeline as) the S3-compatible storage layer.
- **Roles** — owner, admin, and per-domain roles (e.g. a `storageRole` of manager/staff) layered on top of basic membership.

## Business Operations modules

Tasks, CRM, Procurement, Inventory, Finance, and HR are real, shipped, integrated modules — not disconnected add-ons. Procurement's PO receiving, for example, genuinely moves real Inventory stock rather than just referencing it.

## Trust and evidence

Every mutation across Business Workspace calls into one shared, tamper-evident audit chain. The Evidence Graph connects invoices, purchase orders, purchase requests, and AI-proposed actions into one traceable Business Event, with a "Why?" explanation and a portable, independently-verifiable evidence passport. A read-only Digital Twin extends the same discipline into "what would happen if..." simulations — a simulation can compute what a real change would affect, but can never make that change happen, verified by tests that snapshot every touched record before and after and confirm each is left byte-for-byte identical.

## Storage inside Business Workspace

See [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane) for the volume/snapshot/backup-policy control panel, and [S3-Compatible Storage](/docs/products/s3-compatible-storage) for the underlying storage layer itself.

## Related

- [Security Layer](/docs/products/security-layer)
