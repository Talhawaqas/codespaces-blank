---
slug: identity-rewst
title: "Rewst and MSP Automation"
description: "How a Rewst workflow (or any automation platform) drives Inaya identity actions and receives Inaya events, with reference workflows, and an honest statement of what has and has not been tested."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [msp, it-admin, developer]
status: beta
version: current
tags: [rewst, automation, rpa, msp, webhooks, api]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-api, identity-security, identity-msp, identity-rmm-psa-hr]
---

**Status: UNVERIFIED.** Inaya's API and webhooks are tested through their real handlers. No real Rewst workspace has been used, so no Rewst compatibility is claimed. The reference workflows below describe the calls a Rewst workflow makes; they are **not** an importable Rewst export.

## Two directions

| Direction | Mechanism |
|---|---|
| Rewst → Inaya | An HTTP step calls the [identity API](/docs/identity-api) with a service credential, or posts a signed event to `/api/integrations/identity/webhooks/<provider id>`. |
| Inaya → Rewst | Add an **outbound webhook** (Identity & Access → Events out) pointing at a Rewst webhook trigger. Events: `access.revoked`, `sync.failed`, `sync.drift_detected`, `credential.revoked`, `organization.mapping_changed`. Signed the same way. |

## Credentials

Create a credential with only the scopes the workflow needs: `identity:read`, `identity:audit`, `identity:provision`, `identity:revoke`, `identity:reconcile`, `identity:mapping`. An **organization** credential works for one organization. An **MSP** credential names the customer in `X-Inaya-Organization` and works only for customers that accepted an MSP link. A credential cannot create credentials, providers or MSP links, and cannot restore a revoked person.

## Reference workflow: leaver

1. Trigger: your HR system or PSA offboarding ticket.
2. Disable the AD/Entra account (your side).
3. HTTP `POST /api/integrations/identity/users/{email}/revoke` with `{"reason":"Offboarding ticket 1234"}`, header `Authorization: Bearer <credential>`, `Idempotency-Key: offboard-1234`.
4. Read `revocation.state`. `REVOCATION_COMPLETE` ends the workflow; `REVOCATION_PARTIAL` means the person is already frozen but a step needs a retry (Inaya retries automatically; you can call `POST /revocations/retry`).
5. Optionally listen for the `access.revoked` outbound event and attach its `revocationId` to the ticket.

## Reference workflow: joiner

1. Trigger: onboarding ticket.
2. Create the account (your side).
3. `POST /users/provision` with `{ "providerId": "...", "event": { "type": "user.created", "subject": { "externalId": "<objectGUID>", "email": "...", "department": "Finance", "groups": ["Inaya-Finance"] } } }`. Add `"dryRun": true` first to preview.
4. Group and attribute **mappings** decide the access; the workflow does not send roles.

Machine-readable versions of these two workflows live in the repository under `docs/identity-integration/reference-workflows/`.

## Signing a request in a script

```js
import { IdentityIntegration } from "@inaya-network/custody-sdk";
await IdentityIntegration.sendEvent({ baseUrl, providerId, secret, event });          // signed webhook
await IdentityIntegration.disableUser({ baseUrl, credential, organizationId, user: "a@corp.example", reason: "Offboarding 1234" });
```

## Before you claim it works

Run the workflow against a non-production Inaya organization with a real Rewst workspace, then record the result here. Until then this page stays UNVERIFIED.
