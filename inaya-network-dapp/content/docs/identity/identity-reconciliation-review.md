---
slug: identity-reconciliation-review
title: "Reconciliation, Access Review and Orphans"
description: "Find drift between your directory and Inaya, certify who should have access, expire temporary access, and find work left without an owner. Reports and decisions only; nothing is deleted or reassigned silently."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, security-admin, auditor]
status: beta
version: current
tags: [reconciliation, drift, access review, certification, orphans, temporary access, contractors]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-lifecycle, identity-mapping]
---

## Reconciliation and drift

Post a directory export (in chunks of up to 1000 users, `POST /reconcile` with a `snapshotId`; the last chunk says `last: true`), or pull from Microsoft Graph, or call `POST /users/{id}/reconcile` for one person. Each person is compared with Inaya and gets one of:

| Result | Meaning |
|---|---|
| MATCH | Nothing to do. |
| DRIFT | The two disagree in a way policy can explain. |
| CONFLICT | Two directory objects claim the same person; Inaya will not guess. |
| UNRESOLVED | Inaya cannot decide (ambiguous membership, an unknown department). |

Findings include: `DISABLED_STILL_ACTIVE` (critical), `ABSENT_FROM_DIRECTORY` (only on a complete snapshot), `MISSING_IN_INAYA`, `REVOKED_BUT_ENABLED`, `MISSING_GRANTS`, `STALE_GRANTS`, `UNTRACKED_CHANGE` (someone edited the membership outside the integration), `UNRESOLVED_MAPPING`, `IDENTITY_CONFLICT`. Each has a suggested action.

**It reports; it never deletes.** The only automatic action is revoking someone who is disabled or gone at the source, and only if the provider policy `autoRevokeDisabledOnDrift` is on. Otherwise an administrator applies it with one button, through the normal engine (so ordering, verification, audit and evidence apply). A `sync.drift_detected` event is sent if you configured outbound webhooks.

## Temporary and contractor access

Every temporary grant records a sponsor (owner), purpose, scope, start, expiry (at most one year). It expires by itself: the worker retires the grant, re-derives access and verifies it. A contractor whose membership was created only for the engagement is fully revoked when the last grant expires. An existing member's permanent access is untouched. Privileged access cannot be time-boxed here.

## Access reviews

Start a campaign for a scope; each person appears with **who has access, why (source of each grant), since when, until when**. The reviewer chooses **Approve**, **Modify** (remove specific grants) or **Revoke** (full revocation, verified). Nobody can certify their own access, each decision is audited and recorded as a run, and overdue campaigns notify owners once.

## Orphan detection

Open tasks and support tickets, critical functions, risks, workflows, and temporary-access sponsorships owned by someone who no longer has access are listed as **remediations**. Nothing is reassigned automatically. Someone chooses the new owner (who must be an active member), the record is changed, and the decision is audited. You can also turn open items into tasks for a reviewer in a project you choose.

## Manager replacement analysis

Read-only: for a manager, lists dependent people, projects where they are the only member, open work, sponsored temporary access, and replacement candidates already in the same department. It changes nothing.

## Bulk operations

Bulk revoke, restrict, restore or temporary grants run as **jobs**: each person has its own state, one failure does not stop the rest, a crashed worker's claim expires so the job resumes, and a dry-run job changes nothing.
