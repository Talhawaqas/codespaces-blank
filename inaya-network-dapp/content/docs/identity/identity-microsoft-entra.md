---
slug: identity-microsoft-entra
title: "Microsoft Entra ID"
description: "Connect your Entra tenant to Inaya: signed events, optional Microsoft Graph pull with your own app registration, and how this relates to Inaya's existing Microsoft sign-in."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, msp, security-admin]
status: beta
version: current
tags: [entra, azure ad, microsoft graph, tenant, oauth]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-scim, identity-lifecycle, identity-security]
---

## Two different things

| | Sign-in / Azure Blob token authentication (existing) | Identity Integration (this) |
|---|---|---|
| Purpose | Prove who someone is; use Microsoft tokens with the storage endpoint. | Decide who has access in Inaya, from your directory. |
| Where the trust comes from | Microsoft signs the token. | You sign events with the provider secret, or you give Inaya your own read-only app registration. |
| Changes access? | No. | Yes, through the same membership rules. |

Signing in with Entra proves identity; it does **not** map a tenant to an organization and does not by itself decide access. That mapping is explicit here: a tenant id belongs to exactly one organization (enforced by the database), and never inferred from an email domain.

## Connect with events (PARTIAL)

Providers → kind **entra**, external tenant id = the Entra tenant (directory) id. Send events as the canonical schema, or as an Entra-shaped payload (`resourceData`/`user` with `id`, `userPrincipalName`, `mail`, `accountEnabled`, `department`, `jobTitle`, `employeeId`, `manager`, `groups`). `id` (the object id) is the immutable identity. **Status: PARTIAL.** Tested with representative payloads; no real tenant was used. Inaya does not manage Graph change-notification subscriptions (FUTURE); a relay you run (Rewst, a Logic App, an Azure Function) forwards them.

## Optional: pull with your own app registration (UNVERIFIED)

Give Inaya a client id, tenant id and client secret for **your own** app registration with the application permissions `User.Read.All` and `GroupMember.Read.All` (admin consent granted by you). Inaya uses the client-credentials flow to page through users and the members of the groups you list, then reconciles them with Inaya and produces a drift report. The secret is encrypted at rest and never returned. A daily pull can be enabled per provider.

**Status: UNVERIFIED.** This is tested against a local stand-in for the two Microsoft endpoints, including paging, token handling and a wrong-secret failure. It has never run against a real Entra tenant. Test it on a non-production tenant first.

## What Inaya does not do

- It does not recall tokens Microsoft has issued. After a leaver event Inaya's own sessions and credentials are revoked and the membership is frozen, so a Microsoft-issued token can no longer be used to act as that person in Inaya. It cannot invalidate the token elsewhere.
- It does not write to Entra (no disabling, no group changes).
- It does not store Entra passwords or tokens.
