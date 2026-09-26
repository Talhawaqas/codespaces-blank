---
slug: identity-security
title: "Identity Integration Security and Webhooks"
description: "The webhook contract (signature, timestamp, replay, size, tenant binding), credential lifecycle, privilege rules, and what is tested."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [security-admin, developer, it-admin, auditor]
status: beta
version: current
tags: [security, webhooks, hmac, replay, credentials, privilege escalation]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-api, identity-lifecycle, identity-msp]
---

## Inbound webhook

`POST /api/integrations/identity/webhooks/<provider id>`

| Header | Value |
|---|---|
| `X-Inaya-Timestamp` | Unix seconds when you signed. |
| `X-Inaya-Signature` | `v1=` + lowercase hex HMAC-SHA256 of `<timestamp>.<raw request body>` with the provider's signing secret. |
| `Content-Type` | `application/json` |

```js
import { createHmac } from "node:crypto";
const ts = Math.floor(Date.now() / 1000);
const sig = "v1=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
```

Checks, in order: HTTPS (plain HTTP is refused except on localhost) → rate limit → 256 KB size limit → provider exists and the signature matches → timestamp within ±5 minutes (a replay outside the window is refused) → provider active → schema valid → the event's tenant matches the provider's tenant → event id not seen before (a repeat returns `DUPLICATE` and does nothing) → ordering (older than what Inaya applied is `STALE`, recorded and ignored) → lifecycle engine.

An unknown provider and a wrong signature return the same `401`, so the endpoint does not reveal which providers exist. Signature failures are audited.

| Response | Meaning |
|---|---|
| 200 `PROCESSED` / `DUPLICATE` / `STALE` / `UNRESOLVED` | Handled or deliberately ignored; look at `status`. |
| 202 `PENDING` | Another change for the same person is being applied; Inaya retries by itself. Do not resend. |
| 400 | Schema error, plain HTTP. |
| 401 | Not authenticated (signature, timestamp, unknown provider). |
| 403 | Tenant mismatch or provider disabled. |
| 413 / 429 | Too large / too many requests. |
| 503 | Retryable failure; safe to resend the same event id. |

## Outbound events

Inaya can send `access.revoked`, `sync.failed`, `sync.drift_detected`, `credential.revoked`, `organization.mapping_changed` to an HTTPS URL you register, signed exactly the same way with a separate secret. Each event has an id, type, version, time, organization, external tenant, subject, correlation id and a minimal `data` object, never a secret. Delivery is queued, retried with backoff (up to 6 attempts) and idempotent. Private, local and cloud-metadata addresses are refused.

## Service credentials

`idc_…` tokens with explicit scopes, an expiry (at most 365 days), an optional provider binding, last-used time and an owner. Only a hash is stored, the token is shown once, rotation and revocation take effect at once, and listing never returns tokens. Credentials created by a leaver are revoked with them.

## Privilege rules

Owner cannot be granted or modified from outside. Admin from automation waits for a human (Controlled Actions). Automation cannot mint credentials or MSP links, cannot restore a revoked person, and cannot touch an owner. Removal is never gated.

## What is tested

Tenant isolation (cross-org admin, credential and MSP attempts), webhook signature, timestamp window, replay, oversize and schema errors, privilege escalation attempts, stale and racing events (disable → update → enable → disable ends disabled), idempotent replays, secrets absent from responses, audit and payloads. What is **not** tested is any real external product; see the compatibility table in the [overview](/docs/identity-integration).
