---
slug: identity-api
title: "Identity Integration API and SDK"
description: "The organization-scoped identity API under /api/integrations/identity, the Rewst-style actions it exposes, authentication, capabilities, idempotency, and the SDK client."
product: Developer Platform
category: guide
contentType: Reference
audience: [developer, msp, it-admin]
status: beta
version: current
tags: [api, identity, sdk, service credentials, idempotency]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-security, identity-rewst]
---

## Authentication

Send **one** of:

- `Authorization: Bearer idc_…`, an identity service credential. An organization credential works for its organization; an MSP credential also needs `X-Inaya-Organization: <customer id>`.
- A signed-in owner/admin session (the console uses this) with `?orgId=`.
- A signed-in MSP technician session with the customer's `?orgId=`, subject to the delegated role.

Every operation is organization-scoped. The organization is never trusted from the client: a session is checked against the caller's own membership or verified MSP delegation, and a credential is bound to its organization. Responses never contain secrets.

## Capabilities

| Credential scope | Capability | Allows |
|---|---|---|
| `identity:read` | read | Providers (without secrets), users, access, status, metrics, runs, revocations, reports, temporary access, orphans, jobs. |
| `identity:audit` | audit | Audit entries and evidence for a run. |
| `identity:provision` | provision | Provision users, manual overrides (roles/departments/projects), temporary access, retry runs. |
| `identity:revoke` | revoke | Revoke/restrict a person, retry revocations, remediate drift, cancel jobs. |
| `identity:reconcile` | reconcile | Reconcile users, post snapshots, pull from Graph. |
| `identity:mapping` | mapping | Create, change, deactivate mappings. |
| `identity:scim` | n/a | The SCIM endpoint only. |

Providers, credentials, MSP links, access reviews and outbound webhooks are managed by a signed-in owner/admin only. Restoring a revoked person also needs a signed-in owner/admin (or MSP admin).

## Endpoints

Paths are under `/api/integrations/identity`.

| Method and path | Purpose (SOW action) |
|---|---|
| `GET/POST /providers`, `PATCH/DELETE /providers/{id}`, `POST /providers/{id}/rotate-secret`, `POST /providers/{id}/pull` | Providers (`getOrganization`) |
| `GET /organization`, `GET /status`, `GET /metrics` | `getOrganization`, `getSyncStatus` |
| `GET /users/{email\|id}` | `getUser`, `getMembership` |
| `GET /users/by-external?externalId=` | `getUserByExternalId` |
| `GET /users/{id}/access` | `getAccessibleScope` (each grant with its source) |
| `POST /users/provision` | `createUser`, `updateUser`, `disableUser` (by `event.type`), with `dryRun` |
| `POST /users/{id}/revoke` (`mode`: full or restrict) | `revokeUserAccess`, incident restriction |
| `POST /users/{id}/restore` | `restoreUser` (human only) |
| `POST/DELETE /users/{id}/roles`, `/departments`, `/projects` | `assignRole`, `removeRole`, `assignDepartment`, `removeDepartment`, `assignProject`, `removeProject` |
| `POST /users/{id}/reconcile`, `POST /users/reconcile` | `reconcileUser` |
| `POST /reconcile` (snapshot chunk or `mode: "graph"`), `GET /reconcile/reports[/{id}]`, `POST /reconcile/remediate` | `reconcileOrganization` |
| `GET/POST/PATCH/DELETE /mappings` | Mappings |
| `POST /dry-run` | Dry run: `text` ends with `LIVE MUTATION: NO`; `liveMutation: false` |
| `GET /audit`, `GET /evidence?runId=` | `getAuditEvidence` |
| `GET /runs[/{id}]`, `POST /runs/{id}/retry`, `GET /revocations`, `POST /revocations/retry` | Lifecycle and revocation |
| `GET/POST /temporary`, `POST /temporary/{set}/revoke`, `GET/POST /reviews`, `POST /reviews/{id}/items/{item}` | Temporary access, access reviews |
| `GET /orphans`, `POST /orphans/detect`, `GET /orphans/manager-analysis`, `POST /orphans/{id}/resolve` | Orphans |
| `GET/POST /jobs`, `POST /jobs/process`, `POST /jobs/{id}/cancel` | Bulk operations |
| `POST /incident/restrict`, `POST /incident/restore` | Security incident containment |
| `GET/POST/DELETE /credentials…`, `…/msp/…`, `…/outbound/…` | Credentials, MSP, outbound events (human admin) |
| `POST /webhooks/{provider id}` | Signed inbound events (no credential; signature auth). See [Security](/docs/identity-security). |

The SCIM server is at `/api/scim/v2` (see [SCIM](/docs/identity-scim)).

## Idempotency and errors

Send `Idempotency-Key` (8–100 characters) on mutating calls: a repeat returns the recorded response with `"replayed": true`; reusing a key for a different request is `409`. Errors are `{ "error": "…", "reasonCode": "…" }`; `reasonCode` values include `CAPABILITY_MISSING`, `HUMAN_ADMIN_REQUIRED`, `ORGANIZATION_NOT_ALLOWED`, `OWNER_PROTECTED`, `LAST_OWNER`, `TENANT_MISMATCH`, `RATE_LIMITED`.

## SDK

```js
import { IdentityIntegration } from "@inaya-network/custody-sdk";

await IdentityIntegration.sendEvent({ baseUrl, providerId, secret, event });
const r = await IdentityIntegration.disableUser({ baseUrl, credential, organizationId, user: "a@corp.example", reason: "Offboarding 1234", idempotencyKey: "offboard-1234" });
const dry = await IdentityIntegration.dryRun({ baseUrl, credential, providerId, event });   // dry.text
```

Stateless per-call functions: `sendEvent`, `signWebhook`, `getUser`, `getAccessibleScope`, `provisionUser`, `disableUser`, `revokeUserAccess`, `restoreUser`, `assign/removeDepartment`, `assign/removeProject`, `assign/removeRole`, `reconcileUser`, `reconcileOrganization`, `dryRun`, `getOrganization`, `getMembership`, `getSyncStatus`, `getAuditEvidence`, `getAudit`.
