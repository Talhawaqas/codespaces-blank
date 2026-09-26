---
slug: identity-scim
title: "SCIM 2.0 Provisioning"
description: "Inaya's SCIM 2.0 server: what it supports, how users and groups map to lifecycle events, and what is deliberately not supported."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, msp]
status: beta
version: current
tags: [scim, provisioning, users, groups, entra, okta]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-microsoft-entra, identity-lifecycle, identity-mapping]
---

**Status: PARTIAL.** Implemented from RFC 7643/7644 and tested with SCIM requests. Not exercised by a real Entra or Okta provisioning job.

## Set up

1. Providers → connect a provider of kind **scim** (the external tenant id is any stable name for this connection).
2. Credentials → create a credential with the scope `identity:scim`, **bound to that provider**. It is shown once.
3. In your identity provider, set the SCIM base URL to `https://<your Inaya host>/api/scim/v2` and the token to the credential.

## What is supported

| Resource | Operations |
|---|---|
| `/Users` | `GET` (list, `filter=attr eq "value"`, `startIndex`, `count` ≤ 100), `POST`, `GET /{id}`, `PUT`, `PATCH` (`replace active`, `userName`, `displayName`, `title`, `emails`, enterprise `department`/`employeeNumber`), `DELETE` |
| `/Groups` | `GET`, `POST`, `GET /{id}`, `PUT` (membership), `PATCH` (add/remove members), `DELETE` |
| Discovery | `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` |

Filters: `userName`, `externalId`, `emails.value`, `displayName`, `active`, `id` with `eq`, joined by `and`.

## Behavior you should know

- **Every write is a lifecycle event.** SCIM goes through the same engine as webhooks: tenant binding, immutable identity, ordering, mapping, approvals for privileged access, verified revocation, audit and evidence.
- **`active: false` is a leaver.** `active: true` afterwards is a restore request handled by the provider's policy (default: a person must approve). A SCIM client cannot silently bring a revoked person back.
- **`DELETE /Users/{id}` deactivates.** Inaya never deletes a person's records because a directory said so. The record stays and shows `active: false`.
- **Groups are virtual.** A group is the set of users carrying that name. What a group *means* is decided by your group mappings in Inaya, never by SCIM, and a group cannot grant a privileged role on its own.
- `externalId` is the immutable identity and cannot be changed by PATCH. If a client omits it on create, the user name is used with a `scim:` prefix.
- SCIM has no source timestamp, so events are ordered by arrival. A disable still wins over an enable at the same instant.

## Not supported

Bulk operations, sorting, ETags, password changes, group renames, nested groups, `co`/`sw`/`or`/`not` filters. Each returns a SCIM error, never a silent partial result.
