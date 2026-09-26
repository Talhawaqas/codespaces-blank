---
slug: identity-troubleshooting-faq
title: "Identity Integration Troubleshooting and FAQ"
description: "Why an event was refused, ignored or parked, what to check first, and answers to the questions administrators ask most."
product: Business Workspace
category: how-to
contentType: How-To
audience: [it-admin, msp, developer]
status: beta
version: current
tags: [troubleshooting, faq, webhooks, revocation, drift]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-security, identity-lifecycle, identity-api]
---

## An event was not applied. Why?

Look at Identity & Access → Lifecycle, or the response `status`:

| Status / code | Cause | What to do |
|---|---|---|
| `401` | Wrong secret, missing headers, timestamp more than 5 minutes off, unknown provider id. | Check the signing string is `<timestamp>.<raw body>` with the exact bytes you send, that your clock is right, and the provider id. |
| `403 TENANT_MISMATCH` | `tenantId` in the event is not the provider's tenant. | A provider serves exactly one tenant. Fix the sender or create the right provider. |
| `403 PROVIDER_DISABLED` | The provider was disabled. | Enable it under Providers (PATCH status `ACTIVE`). |
| `400 SCHEMA` | Missing `eventId`, unknown `type`, invalid timestamp or email. | The message names the field. |
| `STALE` | An older event than one already applied. | Expected. Send the current state; do not resend the old one. |
| `DUPLICATE` | Same event id. | Expected and safe. |
| `UNRESOLVED` | The person could not be linked without guessing (two candidates, a conflicting object id). | Fix the source, or link explicitly; see the audit entry. |
| `PENDING` / `202` | Another change to the same person is being applied. | Nothing. Inaya retries. |
| `AWAITING_APPROVAL` | A privileged grant needs a human. | Approve it in Approvals (Controlled Actions). |

## A leaver shows PARTIAL

The person is already frozen. One dependency (for example credentials) failed; open Revocation to see which step. Inaya retries with backoff every 5 minutes at most; **Retry unfinished steps** runs it now. It only reruns steps not yet verified.

## The drift report is full of MISSING_IN_INAYA

That means the directory has enabled accounts with no Inaya membership. That may be correct (not everyone uses Inaya). Inaya never creates them from a report; send joiner events, or map only the groups whose members should have Inaya.

## FAQ

**Does Inaya connect to my Active Directory?** No. Your RMM, Rewst or a connector reads AD and sends signed events. Inaya never connects inbound to your domain controllers.

**Can a directory make someone an owner?** No, never. Owners are managed inside Inaya, and the last owner cannot be removed.

**Does disabling someone in Entra end their Inaya session immediately?** When Inaya receives the leaver event it freezes the membership at once (every request is refused) and ends its own sessions. It cannot recall a token Microsoft issued; that token just cannot be used for Inaya any more.

**Can a re-enable event bring access back?** Not by default. `restoreOnEnable` defaults to manual review. When restored, access is re-derived from the directory, not from the old snapshot.

**What if the same email exists in two directories?** Identities are keyed by provider tenant and immutable object id. Two different objects claiming the same email are reported as a conflict and never merged.

**What happens to manual changes an admin made?** They are kept, labelled `INAYA MANUAL OVERRIDE`, and survive directory changes.

**Is it tested with real Entra / AD / Rewst?** No. See the compatibility table in the [overview](/docs/identity-integration): the Inaya side is verified; every external product is PARTIAL or UNVERIFIED until run against the real thing.

**Where is the evidence?** Each run has an audit entry and an Evidence Graph record; open **Lifecycle → Details** or call `GET /evidence?runId=`, and export a Business Event Passport from Evidence.
