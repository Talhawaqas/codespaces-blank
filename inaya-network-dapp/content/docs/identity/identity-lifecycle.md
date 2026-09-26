---
slug: identity-lifecycle
title: "Joiner, Mover, Leaver"
description: "What happens to Inaya access when someone joins, changes team or leaves; how immediate revocation works, its states, and the honest limits on tokens and sessions."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, security-admin, auditor]
status: beta
version: current
tags: [joiner, mover, leaver, revocation, restore, tokens, sessions]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-mapping, identity-security, identity-reconciliation-review]
---

## Joiner

A "created" event from a provider (or a `hr.joiner`, `psa.onboarding`, SCIM create) does this, in order: resolves the identity (immutable object id first; email only as a controlled fallback when exactly one person matches and policy allows), checks the plan's seat limit, creates the membership with the role `member` (never owner), applies the default grants and the mapped grants, records the run, notifies administrators. Repeating the same event, or sending "created" twice, never creates a second person.

If someone already has an Inaya membership, they are **linked**, not overwritten: what they already had is captured as `INAYA (existing)` grants first, so the integration can never silently remove it.

## Mover

A department change or group change reads the old and new state, calculates the difference, removes only the grants **of that provider** the new state no longer justifies, adds the new ones, and preserves everything else: manual overrides, existing access, access from other sources. Then it verifies and audits.

## Leaver

A disable, delete, termination or offboarding event runs the revocation:

| Step | What it does | How it is verified |
|---|---|---|
| Freeze | The membership becomes `revoked`. Every request for this organization is refused from this moment. | The membership is re-read. |
| Sessions | Inaya sign-in sessions are ended. Sessions belong to an email, so if the person is active in another organization they are kept (policy `sessionRevocation`), and access here is already blocked by the freeze. | No sessions remain (or the skip reason is recorded). |
| Credentials | API keys, storage credentials and integration credentials created by the person are revoked. | None remain active. |
| Permissions | Grants from the directory are retired and department/project/module access removed. | Access is re-derived and re-read. |
| Sharing | Share links created by the person are revoked. | None remain active. |
| Break-glass | Any active break-glass grant is ended. | None remain active. |

The identity record is marked disabled **first**, so a stale "enable" event arriving later can never restore access.

### States

`REVOCATION_PENDING` → `REVOCATION_PARTIAL` (the person is frozen, one dependency failed; it is retried automatically with backoff and you can retry by hand) → `REVOCATION_COMPLETE` (every step verified) or `REVOCATION_FAILED`. Failures are visible in Identity & Access → Revocation and never disappear silently. Retrying is safe: only steps not yet verified run again.

### Protected cases

- **Owners** are never changed by a directory. The only active owner cannot be revoked (`LAST_OWNER`).
- Removal is never delayed and never needs approval. Adding **privileged** access (admin, or a mapping flagged privileged) waits for a human through Controlled Actions and its delay, and is re-checked at execution: it is never applied to someone who was disabled in the meantime.

### Token and session reality

Inaya can end **its own** sessions and credentials. It cannot recall a token another provider issued (for example a Microsoft access token, or a token a third-party service holds). What Inaya guarantees instead: authorization is re-checked against the membership on every request, so a frozen person's tokens stop working *for Inaya*. Where an external system holds its own token for that person, revoke it there (your Rewst workflow can do so in the same run).

## Restore

A "re-enabled" event never resurrects access on its own by default (`restoreOnEnable`: `manual_review`, `auto`, or `never`). A person with authority restores from Identity & Access (or the API with a human session). Restoring **re-derives** access from the directory's current state and the mappings, not from the old snapshot, and privileged grants still need approval. A plan-limit is checked again.

## Ordering and idempotency

Events carry a timestamp and optionally a sequence. An older event than what Inaya has already applied is recorded as **stale** and ignored. If two events share the same instant with no sequence, the disable wins. Replaying an event id never repeats an action. A sequence such as disable → update → enable → disable ends disabled.
