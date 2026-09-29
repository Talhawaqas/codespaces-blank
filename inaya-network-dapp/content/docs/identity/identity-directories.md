---
slug: identity-active-directory
title: "Active Directory"
description: "How Active Directory changes reach Inaya (through an RMM, Rewst or a connector you run), what is mapped, and what Inaya never does."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, msp]
status: live
version: current
tags: [active directory, ad, rmm, rewst, objectGUID, userAccountControl, ldap]
lastVerifiedAt: "2026-09-29"
relatedDocs: [identity-integration, identity-rewst, identity-lifecycle]
---

## The boundary

**Inaya never connects to your domain controllers.** There is no inbound LDAP, ever. Your side reads Active Directory and sends signed events to Inaya — outbound only. **Status: Proven** — verified against a real Windows Server domain controller (real LDAP bind, full and incremental sync, a real joiner with real attributes processed end to end).

## Connect

Two ways to send AD events, both ending at the same signed webhook:

1. **Inaya's own sync agent** (`ad-sync-agent/`) — a small, real, open-source Node agent you run inside your own network next to your DC. It does the LDAP work for you: a real bind, `objectCategory=person` search excluding computer accounts, and AD's own `uSNChanged` watermark for real incremental sync after the first run. Point it at a read-only service account (never a domain admin) and it does the rest. See its `README.md` for setup.
2. **Your own script, RMM, or Rewst workflow** — read AD yourself (however you already do it) and send the canonical event, or a payload with an `ad`/`user` object carrying the attributes below, signed the same way.

Either way:
1. Identity & Access → Providers → kind **ad** (or **rmm**), external tenant id = your domain's own DNS name (e.g. `contoso.local`) — this must exactly match the `tenantId` every event carries, or it's rejected.
2. Copy the signing secret (shown once). Sign each event with it (see [Webhooks](/docs/identity-security)).

## What the AD adapter understands

Send either the canonical event, or a payload with an `ad` / `user` object carrying the usual attributes:

| AD attribute | Meaning in Inaya |
|---|---|
| `objectGUID` (or `objectSid`) | The **immutable identity**. This is the primary key; email is never the primary key. |
| `userAccountControl` | Bit 2 set means disabled → a leaver. `accountEnabled` is used if present. |
| `memberOf` | Group names (the `CN=` part) used by group mappings. |
| `mail` / `userPrincipalName` | Email used to link to an Inaya person, only when policy allows and exactly one person matches. |
| `department`, `title`, `manager`, `employeeID`, `employeeType` | Attribute mappings. |
| `uSNChanged` | Used as the event's sequence for ordering. |
| `whenChanged` | The event's timestamp. |

## Limits, stated plainly

- A disabled AD account does not, by itself, end an Inaya session that another sign-in method created; Inaya revokes its own sessions, credentials and permissions when it receives the leaver event.
- Nested group expansion is done on your side; send the groups that should count.
- Password, MFA and Kerberos state are not read or changed.
