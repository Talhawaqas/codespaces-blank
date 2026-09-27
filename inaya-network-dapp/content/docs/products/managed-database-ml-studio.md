---
slug: managed-database-ml-studio
title: Managed Database, Document Intelligence & AI/ML Studio
description: A real, provisioned PostgreSQL database, a general document-understanding studio for any document type, and an AI workbench for data cataloguing, quality checks, model registry and a governed sandboxed code runner.
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, it-admin, developer]
status: live
version: current
tags: [database, postgresql, supabase, document-intelligence, ai, ml, sandbox, catalog]
lastVerifiedAt: "2026-09-27"
relatedDocs: [business-workspace, ai-bookkeeper, legacy-data-access]
---

## What it is

Three related capabilities added together, because they share the same underlying need: real, governed infrastructure Inaya's own serverless hosting cannot provide by itself.

- **Databases** — provision, start, stop, back up, restore to a point in time, and query a real, hosted PostgreSQL database from inside the Business Workspace, through a real external provider (Supabase). Inaya's own hosting (Vercel serverless functions) cannot run a database engine process itself — nothing stays running between requests — so this manages a real database elsewhere rather than pretending to host one.
- **Document Intelligence** — a general document-reading studio. Where Document & Invoice Automation and the AI Bookkeeper read specific financial documents, Document Intelligence reads *any* document type: built-in readers for invoices, purchase orders, receipts and contracts, plus the ability to define a custom one for anything else, with a real lifecycle (draft, testing, ready, live) before it is trusted with real work.
- **AI/ML Studio** — a workbench for a data team: a catalogue of an organization's data sources and models, automatic data-quality checks, a model registry that fingerprints and version-tracks whatever a team already produced, named evaluation metrics, and a single governed way to run one piece of code in an isolated, disposable sandbox.

## What you can do

| Area | What it gives you |
|---|---|
| Databases | Provision a real PostgreSQL instance, start/stop it, list its backups, restore to an earlier point in time, and run a query — all from the Business Workspace, all audited |
| Document Intelligence | Submit a document to a built-in or custom analyzer; see every extracted field's confidence and whether it was actually found in the document's own text; correct a wrong reading without losing the original |
| Data catalogue | Register a real data source's table, a Document Intelligence analyzer, or a document project as one entry — checked against the real thing before it is accepted |
| Data quality | Run NOT_NULL, UNIQUE, RANGE and minimum-row-count checks against a real cataloged table and see the exact numbers behind a pass or fail |
| Model registry | Register a model version with a real file hash, move it through the same draft-to-live lifecycle as an analyzer, and record named evaluation metrics against it |
| Sandboxed code | Run one Python or Node.js snippet in a fresh, isolated sandbox with no internet access by default, destroyed the instant it finishes |

## The safety rule

Provisioning a database and running code both touch real, potentially billable external systems, so both are restricted to the organization's owner or an admin, both are rate-limited, and every action is recorded in the organization's audit trail and Evidence Graph. The sandbox never receives Inaya's own server secrets, and it cannot reach the internet unless a person explicitly turns that on for one specific run. A database credential is stored encrypted, never in plain text.

## What is proven and what is not

| Area | Status |
|---|---|
| Database provisioning, start/stop, backup listing, point-in-time restore, query | Proven — real Supabase Management API, real database for Inaya's own records |
| Document reading, confidence, grounding, human correction, analyzer evaluation | Proven — real database, 10 of 10 tests |
| Data catalogue, data quality, model registry, evaluations | Proven — real sample database, 5 of 5 tests |
| Sandboxed code execution | Proven — 5 of 5 tests, each a real, live sandbox created and destroyed on a real cloud account |
| Model training | Not built — Inaya does not train AI models on its own infrastructure; "registering a model" tracks a file a team already produced elsewhere |
| Persistent notebooks | Not built, deliberately — each code run is fresh and isolated; nothing is remembered between two runs |

## The bottom line

A business can now point its own tools at a real database Inaya manages for it, get any document — not just invoices — read and turned into structured data with a visible confidence level, and give a data team a safe, audited way to catalogue data, check it, and run code, without any of it needing a separate vendor relationship or its own infrastructure to operate.
