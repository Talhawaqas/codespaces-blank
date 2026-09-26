---
slug: identity-architecture
title: "Identity Integration Architecture"
description: "How an identity change travels from your directory, HR system or automation to Inaya access, and where each guarantee is enforced."
product: Business Workspace
category: concept
contentType: Concept
audience: [it-admin, security-admin, developer, auditor]
status: beta
version: current
tags: [identity, architecture, grants, revocation, evidence]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-lifecycle, identity-security]
---

## The path of one event

```text
Source (Entra, AD via RMM/Rewst, HR, PSA, SCIM)
  -> signed HTTPS webhook / SCIM request / API action
  -> signature + timestamp + size + rate limit          (rejected here: nothing recorded as accepted)
  -> canonical event (one schema; source adapters map into it)
  -> tenant binding: provider -> exactly one organization
  -> idempotency: (provider, event id) is stored once
  -> per-identity lock, then ordering: stale events are recorded and ignored
  -> identity resolution: immutable object id, then employee id (if authoritative), then email only as a controlled fallback
  -> classification: joiner / mover / leaver / restore / status change / incident
  -> plan (dry run stops here)
  -> execute -> derive access from the grant ledger -> write it to the existing membership fields
  -> independent verification
  -> audit chain + Evidence Graph + notification
```

## Grants, sources and effective access

Every reason a person has access is a row in a **grant ledger** with a source: `ENTRA`, `AD`, `HR`, `PSA`, `RMM`, `SCIM`, `GENERIC` (the external baseline), `INAYA MANUAL OVERRIDE` (a person's decision), `INAYA (existing)` (access that was already there before the integration took over), `TEMPORARY`.

**External baseline + Inaya local override = effective access.** The effective access is derived from the active rows and written back to the fields Inaya already authorizes from (membership role, departments, module roles, project membership). A mover loses only the grants of its own source that the new state no longer justifies. Owner is never touched.

## Where each guarantee lives

| Guarantee | Enforced by |
|---|---|
| A tenant belongs to one organization | A unique database index on (kind, tenant). |
| A leaver cannot act at once | Every request re-checks the membership; a frozen membership is refused everywhere, including for API keys and share links created by that person. |
| No second approval engine | Privileged additions use Controlled Actions (`IDENTITY_LIFECYCLE`), re-checked at execution. |
| Tamper-evident history | The existing hash-chained audit trail. |
| Secrets never leak | Signing secrets and Graph secrets are encrypted at rest; tokens are stored as hashes; nothing secret is in audit, evidence, notifications or errors. |

## Collections

`identity_providers`, `identity_external_users`, `identity_mappings`, `identity_grants`, `identity_events`, `identity_runs`, `identity_revocations`, `identity_credentials`, `identity_msp_*`, `identity_reviews`, `identity_review_items`, `identity_drift_reports`, `identity_jobs`, `identity_remediations`, `identity_webhooks`, `identity_deliveries`. Every query filters by organization.

## Background work

`/api/cron/identity` runs every 5 minutes: temporary access expiry, retrying unfinished revocations with backoff, retrying parked events, bulk jobs, review reminders, hourly orphan detection, optional daily Graph pull, outbound event delivery. Each step is idempotent and isolated.
