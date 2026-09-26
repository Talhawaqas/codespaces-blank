---
slug: identity-rmm-psa-hr
title: "RMM, PSA and HR Webhooks"
description: "Generic adapters that normalize RMM, PSA (ITSM) and HR events into Inaya joiner, mover, leaver and status-change events."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [msp, it-admin, hr-admin]
status: beta
version: current
tags: [rmm, psa, itsm, hr, webhook, adapters]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-rewst, identity-lifecycle, identity-security]
---

**Status: UNVERIFIED** for every named product. The adapters are generic and are tested with representative payloads; no HR, PSA or RMM product has been connected. Nothing here says a specific vendor works.

## One schema for everything

Whatever the source, an event becomes:

```json
{
  "eventId": "unique per event, 6-128 chars",
  "type": "user.created | user.updated | user.disabled | user.enabled | user.department_changed | user.role_changed | user.group_changed | user.deleted | hr.joiner | hr.mover | hr.leaver | hr.status_change | psa.onboarding | psa.offboarding | security.restrict | security.restore",
  "tenantId": "the provider's external tenant",
  "occurredAt": "ISO timestamp",
  "sequence": 0,
  "correlationId": "optional",
  "subject": { "externalId": "immutable id", "email": "", "upn": "", "employeeId": "", "displayName": "", "department": "", "jobTitle": "", "managerExternalId": "", "accountEnabled": true, "employmentStatus": "ACTIVE|TERMINATED|...", "employeeType": "contractor", "contractEndDate": "ISO date", "groups": [], "attributes": {} }
}
```

## HR

Provider kind **hr**. The adapter maps common event names: hire/joiner/rehire → joiner; transfer/promotion/mover → mover; termination/resignation/leaver → leaver; leave/status change → status change (attributes recorded, **no access change**). The effective date becomes the timestamp. A contractor with a `contractEndDate` gets a temporary membership that expires by itself.

## PSA / ITSM

Provider kind **psa**. An onboarding ticket becomes `psa.onboarding`, an offboarding ticket `psa.offboarding` (account disabled). The ticket id becomes the correlation id and part of the event id, so a ticket that fires twice is processed once.

## RMM

Provider kind **rmm** (uses the Active Directory adapter): an RMM script reads AD and posts changes. See [Active Directory](/docs/identity-active-directory).

## Rules

Signed with the provider secret; ordered and idempotent; unknown tenants refused; a status change alone never removes access; HR-driven access is subject to the same mappings and the same privileged-approval rule as any other source.
