---
slug: identity-active-directory
title: "Active Directory"
description: "How Active Directory changes reach Inaya (through an RMM, Rewst or a connector you run), what is mapped, and what Inaya never does."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, msp]
status: beta
version: current
tags: [active directory, ad, rmm, rewst, objectGUID, userAccountControl]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-rewst, identity-lifecycle]
---

## The boundary

**Inaya never connects to your domain controllers.** There is no inbound LDAP. Your side (an RMM script, a Rewst workflow, or a small connector) reads Active Directory and sends signed events to Inaya. **Status: UNVERIFIED** against a real domain; the adapter is tested with representative payloads only.

## Connect

1. Identity & Access → Providers → kind **ad** (or **rmm**), external tenant id = your domain SID or forest name.
2. Copy the signing secret. Sign each event with it (see [Webhooks](/docs/identity-security)).

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
