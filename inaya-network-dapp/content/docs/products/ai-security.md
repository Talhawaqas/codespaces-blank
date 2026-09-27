---
slug: ai-security
title: "AI Security Workflow"
description: "One checked, recorded checkpoint in front of Inaya's text AI assistants: it detects prompt injection and personal data, applies your organization's policy, sends risky actions for human approval, and records every decision in the audit trail and Evidence Graph."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, it-admin, security, auditor]
status: live
version: current
tags: [ai, security, prompt injection, pii, policy, guardrails, evidence, audit]
lastVerifiedAt: "2026-09-27"
relatedDocs: [business-workspace, ai-business-operations-manager, security-layer]
---

## What it is

Inaya has several AI assistants. Each used to call the AI model on its own, with no shared safety checks. The AI Security Workflow puts a single gateway in front of the text assistants so that:

- instructions hidden inside a message or a document (prompt injection) cannot trick the AI into ignoring its rules or exposing data;
- personal and sensitive data is detected before it goes where it should not;
- your organization's policy decides what is allowed, warned about, redacted, blocked or sent for human approval;
- every decision is recorded, so you can later see **why** a request was allowed or blocked.

```text
person -> identity + permissions (unchanged) -> AI Security Gateway (input checks)
       -> AI model -> AI Security Gateway (output checks) -> person
                      \-> audit chain + Evidence Graph (every decision)
```

## What is real, and what is not

| Capability | Status |
|---|---|
| Prompt-injection detection (five attack families) and personal-data detection (email, phone, SSN, Luhn-validated card numbers) | VERIFIED (23 of 23 adversarial tests) |
| Per-organization policy, versioned, manager-only, with every version kept | VERIFIED |
| Coverage of all six text AI routes: business assistant, wallet assistant, security assistant, Learn assistant, documentation assistant, OS chat | VERIFIED (a coverage test fails if a model-calling route is added without the gateway) |
| A real injection attempt blocked on the live business assistant, normal chat unaffected | VERIFIED |
| **Voice assistant** | **Not covered.** Speech goes from the browser straight to the speech model, so there is no server-side text to inspect. Voice routes remain authenticated, rate-limited and permission-scoped. |
| Documentation assistant output | Input checks only (it streams), so its output is not masked |
| Routes with no organization (wallet, security and Learn assistants, docs) | Run the platform default policy and log without an organization audit chain, because there is no organization to own it |
| An independent security certification | **Not claimed.** This is strong protection, not a guarantee that a model is perfect. |

## How decisions are made

Every request gets one decision and a severity:

| Decision | Meaning |
|---|---|
| ALLOW | Nothing concerning was found |
| WARN | Allowed, but recorded with a warning |
| REDACT | Sensitive values are masked before the request or reply continues |
| BLOCK | The request stops; the person sees a clear message |
| REQUIRE_APPROVAL | A high-risk action is proposed instead of executed, and goes through Controlled Actions: approval, then the 36-hour delay, then execution |

Severity is INFO, LOW, MEDIUM, HIGH or CRITICAL. The categories are prompt injection, personal data, unauthorized access, excessive agency, output security, model integrity, abuse and validation. Every decision records the policy version that was active, so a later policy change never rewrites what an old decision meant.

Retrieved documents and pasted text are always treated as **untrusted data**: they are wrapped so the model cannot mistake them for instructions, and an instruction found inside one cannot widen permissions or trigger an action.

## The default policy

Until a manager changes it, an organization gets these defaults:

| Setting | Default |
|---|---|
| Allow external models | No |
| Allow sensitive data | No |
| Require human approval for high-risk actions | Yes |
| Token budget per request | 100,000 |
| Allowed providers | Google |
| Retention of decision records | 30 days |

## How to use it

1. Open **Business Workspace** and choose **AI Security** in the sidebar.
2. **Activity** lists every AI request the gateway checked: time, who, which assistant, the decision and severity. Select a row and use **Why?** to see the checks that ran and the reason for the decision.
3. **Model Inventory** lists the AI components in use, seeded from what is actually configured, and flags anything unrecognized.
4. **Policy** shows the active policy (any member can read it; only managers can change it). Saving creates a new version; earlier versions are kept, never overwritten, so an old "Why?" answer still resolves against the policy that was active then.

The same information is available to your own tools through the organization API (session-authenticated, the same permissions as the screen):

```text
GET  /api/orgs/ai-security/events?orgId=<id>          the decision log
GET  /api/orgs/ai-security/explain/<eventId>?orgId=<id>   the "Why?" answer for one decision
GET  /api/orgs/ai-security/models?orgId=<id>          the model inventory
GET  /api/orgs/ai-security/policy?orgId=<id>          the active policy (any member)
PUT  /api/orgs/ai-security/policy                     body { orgId, policy }: save a new policy version (managers)
```

## Why use it

- Attackers hide instructions inside documents and messages; without a shared guard each assistant would have to defend itself.
- People paste private data into chats; the gateway catches it before it leaves.
- Auditors and customers can ask "why did the AI do that?" and get an answer from the tamper-evident audit trail and the Evidence Graph, not from memory.
- A risky AI action still waits for a person, exactly like every other AI action in Inaya.

## Limits worth knowing

- Detection is deterministic pattern matching plus policy rules. It catches the known attack families it was built and tested against; it does not promise to catch every possible attack.
- Supply-chain scanning of AI dependencies and model-drift monitoring beyond the static inventory check are not part of this release.
- The guard sits in front of Inaya's own assistants. It does not inspect what an outside AI tool you connect through the API does with data you send it.
