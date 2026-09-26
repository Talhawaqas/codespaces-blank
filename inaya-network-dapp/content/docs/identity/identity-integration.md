---
slug: identity-integration
title: "Identity Integration (Active Directory, Entra, Rewst, SCIM)"
description: "Let your directory, HR system, PSA or MSP automation drive who has access to Inaya. Joiners, movers and leavers change access automatically, a leaver is cut off at once, and Inaya stays the authority, verifying and recording every change."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, msp, security-admin, auditor]
status: beta
version: current
tags: [identity, active directory, entra, rewst, scim, joiner, mover, leaver, msp, revocation]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-architecture, identity-active-directory, identity-microsoft-entra, identity-scim, identity-rewst, identity-lifecycle, identity-security, identity-api, identity-troubleshooting-faq]
---

## What it is

Identity Integration connects the systems that already know who works for you (Microsoft Entra ID, Active Directory, an HR system, a PSA, an RMM, Rewst) to Inaya. When someone joins, moves team, or leaves, the change reaches Inaya as a signed event and Inaya adjusts that person's access. It is in **Business Workspace → Identity & Access** (owners and admins).

It is not a second permission system. Inaya's own authorization stays exactly as it was: the membership, department, project and module roles it already checks on every request. Identity Integration only decides what those should contain, and remembers why.

## What it does

- **Joiner:** creates the membership, gives the access the mapping justifies, records it.
- **Mover:** removes the old team's access, adds the new team's, and keeps everything unrelated (including access an administrator gave by hand).
- **Leaver:** freezes the account first, then ends sessions, credentials, workspace permissions, shares and break-glass grants, and **verifies each step independently**.
- **Drift detection:** compares a directory export with Inaya and reports every difference. It never deletes anything.
- **Extras:** temporary and contractor access that expires by itself, periodic access reviews, orphaned-work detection, security-incident restriction, dry-run, bulk jobs, MSP delegation.

## Design rules

1. **Inaya stays the authority.** A directory can propose; Inaya applies its own rules. "Owner" can never be granted or changed from outside, and the last owner can never be revoked.
2. **Removal is never delayed.** Adding privileged access (admin) goes through Controlled Actions and its delay; taking access away does not.
3. **Fail closed.** Unknown tenant, ambiguous identity, wrong signature, stale event: nothing changes, and the reason is recorded.
4. **Everything is evidence.** Each run is in the audit chain and the Evidence Graph (subject `IDENTITY_LIFECYCLE`) and can be exported as a Business Event Passport.

## Compatibility status (read this before you rely on it)

Nothing on this page claims compatibility that has not been tested against the real product. **VERIFIED** means it ran in an automated test against a real database; **UNVERIFIED** means the code exists and is tested against a stand-in, but has never run against the real external product.

| Area | Status | What that means |
|---|---|---|
| Inaya-side lifecycle engine (joiner, mover, leaver, restore, ordering, idempotency) | VERIFIED | Automated tests on a real MongoDB, including races such as disable → update → enable → disable ending disabled. |
| Verified revocation and its state machine | VERIFIED | Pending, partial (with retry), complete and failed are covered, including an injected failure. |
| Webhook security (signature, timestamp window, replay, size, tenant binding) | VERIFIED | Tested through the real route handler. |
| Service credentials, scopes, MSP isolation and delegated roles | VERIFIED | Cross-tenant attempts are tested and audited. |
| Reconciliation, access reviews, orphans, temporary access, bulk jobs, outbound events | VERIFIED | Tested on a real database. |
| SCIM 2.0 server | PARTIAL | Protocol behavior tested with SCIM requests. Not exercised by a real Entra or Okta provisioning job. |
| Microsoft Entra ID: events in Entra-shaped payloads | PARTIAL | Adapter tested with representative payloads. No real Entra tenant was used. |
| Microsoft Graph pull (your own app registration) | UNVERIFIED | Tested against a local stand-in for Microsoft. Never run against a real tenant. |
| Active Directory (through an RMM, Rewst or a connector) | UNVERIFIED | Adapter tested with representative payloads. No real domain. |
| Active Directory direct (LDAP from Inaya) | UNSUPPORTED | Inaya never connects inbound to your domain controllers. |
| Rewst | UNVERIFIED | Reference workflows are provided. No real Rewst workspace was used. |
| RMM, PSA, HR adapters | UNVERIFIED | Generic normalization tested with representative payloads. |
| Okta, Google Workspace, Ping native connectors; Entra change-notification subscription management | FUTURE | Not built. |
| Recalling Microsoft-issued tokens | UNSUPPORTED | Inaya cannot recall tokens another provider issued. See [Joiner, mover, leaver](/docs/identity-lifecycle). |

## First steps

1. Business Workspace → Identity & Access → **Providers** → connect a provider (kind, external tenant id). Copy the signing secret; it is shown once.
2. **Mappings**: map directory groups or attributes to departments, projects and roles.
3. Point your source at the webhook (see [Webhooks](/docs/identity-security)) or create a SCIM credential.
4. Try a **Dry run** first: it shows what would happen and ends with `LIVE MUTATION: NO`.
