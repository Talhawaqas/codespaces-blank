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
lastVerifiedAt: "2026-11-16"
relatedDocs: [security-layer, appointments-email-marketing, education-os, hospitality-os, ai-bookkeeper, customer-portal]
---

## Overview

Business Workspace is Inaya's SaaS-style layer on top of the core storage/encryption platform: organizations, departments, projects, documents, and a real role-based permission model, with a growing set of business-operations modules built directly on top of it rather than as separate products.

## Core structure

- **Organizations** — the top-level tenant. Sign-in is an emailed sign-in link or Google, independent of crypto wallets; a wallet is never required to use Business Workspace.
- **Departments and Projects** — the scoping unit most permissions are checked against (`canAccessDepartment`).
- **Documents** — org-wide file storage with per-document ACL/versioning, distinct from (but built on the same underlying pipeline as) the S3-compatible storage layer.
- **Roles** — owner, admin, and per-domain roles (e.g. a `storageRole` of manager/staff) layered on top of basic membership.

## Packages and getting started

The Business Workspace launches publicly on 1 January 2027. A new company starts on the package screen and its workspace opens once a package is paid and activated:

| Package | Users included | Storage | USD a month | PKR a month (Pakistan) |
| --- | --- | --- | --- | --- |
| Starter | 2 | 250 GB | $7.99 | PKR 8,000 |
| Professional | 5 | 1 TB | $39 | PKR 20,000 |
| Business | 10 | 5 TB | $99 | PKR 30,000 |
| Enterprise | 25 | 10 TB | $799 | PKR 60,000 |

Packages are requested from inside the Workspace ("Request activation") and paid by NayaPay or bank transfer against an emailed invoice; there is no card checkout. Annual billing costs about 17% less. Extra users cost $3 a month (PKR 2,500), up to 3 on Starter, 10 on Professional, 15 on Business and 20 on Enterprise. Companies in Pakistan pay a one-time setup fee (PKR 10,000 for Starter, 25,000 otherwise). The [step-by-step setup guide](/docs/business-workspace-guide.md) walks through creating a company, choosing a package and the first week.

## Your data and help

- Owners and admins can download all of the company's records and documents as one ZIP file from Settings, then Billing.
- Company records are backed up every day, encrypted.
- "? Help" opens the support assistant: it checks your account, fixes common problems (a missing company name, the wrong business type, a lost invitation) after an owner or admin confirms, and emails anything else to the support team, who reply within one working day.

## Business Operations modules

Tasks, CRM, Procurement, Inventory, Finance, and HR are real, shipped, integrated modules — not disconnected add-ons. Procurement's PO receiving, for example, genuinely moves real Inventory stock rather than just referencing it.

Alongside them:

- [Appointments & Email Marketing](/docs/products/appointments-email-marketing): a public booking page, team calendars and reminders, plus approved email campaigns and follow-up sequences to CRM contacts (Business and Enterprise packages).
- [Inaya Connect](/docs/products/inaya-connect): your own WhatsApp Business number connected to the workspace: a shared team inbox, a business assistant staff can ask about sales, stock and orders, an optional customer assistant, and bills sent on WhatsApp landing in AI Bookkeeper (Business and Enterprise packages).
- [AI Bookkeeper](/docs/products/ai-bookkeeper), [Document & Invoice Automation](/docs/products/document-automation), [Automations](/docs/products/ai-business-operations-manager) and the [Customer Portal](/docs/products/customer-portal).

## Industry editions

The same workspace can run as an industry edition, chosen at signup or later in Settings: Health, Legal, Regulated Enterprise, Financial / Private Capital, Government, [Education](/docs/products/education-os) and [Hospitality](/docs/products/hospitality-os). An optional ERP-style layout puts each industry's own modules first, and a short sidebar plus an All apps launcher keep everyday areas close at hand.

## Trust and evidence

Every mutation across Business Workspace calls into one shared, tamper-evident audit chain. The Evidence Graph connects invoices, purchase orders, purchase requests, and AI-proposed actions into one traceable Business Event, with a "Why?" explanation and a portable, independently-verifiable evidence passport. A read-only Digital Twin extends the same discipline into "what would happen if..." simulations — a simulation can compute what a real change would affect, but can never make that change happen, verified by tests that snapshot every touched record before and after and confirm each is left byte-for-byte identical.

## Storage inside Business Workspace

See [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane) for the volume/snapshot/backup-policy control panel, and [S3-Compatible Storage](/docs/products/s3-compatible-storage) for the underlying storage layer itself.

## Related

- [Security Layer](/docs/products/security-layer)
- [Appointments & Email Marketing](/docs/products/appointments-email-marketing)
- [Education OS](/docs/products/education-os)
- [Hospitality OS](/docs/products/hospitality-os)
- [Inaya Connect](/docs/products/inaya-connect)
