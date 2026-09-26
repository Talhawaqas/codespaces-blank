---
slug: ai-business-operations-manager
title: Automations (AI Business Operations Manager)
description: Build, schedule and audit business workflows that combine your Inaya data, an AI Operations Manager, rules and notifications, with human approval for anything that changes a record and evidence for every run.
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, it-admin, auditor]
status: live
version: current
tags: [automation, workflows, ai, notifications, approvals, evidence, slack, gmail]
lastVerifiedAt: "2026-09-26"
relatedDocs: [business-workspace, security-layer, sovereign-nas]
---

## What it is

Automations lets an authorized person build a workflow on a visual canvas: a trigger (a schedule, a button, an event, a webhook), steps that read your Inaya data, an AI Operations Manager that analyses it, rules that decide what happens, and notifications or requests for approval. It connects the parts of Inaya you already have (CRM, invoices, tasks, procurement, inventory, Business Brief, Trust Health, Digital Twin, Evidence Graph, notifications and the approval system). It does not replace any of them.

The idea is: **data, then AI, then a decision, then governance, then action, then evidence.**

## What you can do

| Area | What it gives you |
|---|---|
| Visual editor | Add, connect, move, disable and duplicate steps; zoom and pan; live validation; unsaved-changes marker; save a draft, test, dry-run, execute, publish, and roll back to an earlier version |
| Triggers | Manual, schedule (daily, weekly, monthly, interval, in your timezone), event, webhook (signed), API key, Evidence Graph event, Digital Twin completion, data change |
| Data | CRM and sales, overdue invoices, tasks, procurement, inventory, projects, documents, security events, backup status, Trust Health, Business Brief, Evidence Graph events, Digital Twin results, and your helpdesk through a controlled HTTP connector |
| Transform | Merge, join, filter, map, select, rename, sort, aggregate, group, deduplicate, derive. There is no code step. |
| KPI snapshot | A permission-scoped snapshot with its period, sources, organization and calculation notes, ready for the AI and for evidence |
| AI Operations Manager | Gemini (server-side only) returns a structured assessment: urgent or not, classification, confidence, findings, recommendations. It can only call tools you enable |
| Rules | Conditions with AND, OR, NOT, comparisons, thresholds and the AI's structured result |
| Notifications | Inaya notifications and email (through Inaya), plus Slack and Gmail. Repeats are deduplicated, so a retry never sends twice |
| Approvals | A step can only *propose* a business change. A person approves it, the normal delay applies, and the existing system performs it |
| Test and dry run | Test uses synthetic data; dry run reads real data. Both simulate every write and label every output |
| Evaluations | Save test cases with expected branches, notifications, tools and latency, and run them safely |
| Evidence | Every run is recorded in your tamper-evident audit trail and the Evidence Graph, with an exportable Evidence Passport and a plain "why did it do this" explanation |
| Health | Automation health, metrics, retention controls and failure notifications |

## How safety works

- **Permissions follow the person running it, not the author.** A workflow reads only what the running person can see. Sharing a workflow does not lend anyone your access, and a scheduled run stops if its owner has lost access.
- **The AI cannot go beyond its tools.** Tool names, arguments and permissions are checked by the server, not by the model. A tool that changes data can only ask for human approval.
- **Untrusted text stays data.** Instructions hidden in a ticket or document are removed before the AI sees them and are recorded as an AI-security event.
- **Secrets never sit in a workflow.** Credentials are stored encrypted and referenced by id; every use is audited and exports never contain them.
- **Outbound calls are locked down.** HTTPS only, an allowlist of hosts, no private or metadata addresses, no redirects, size and time limits.
- **Runs are safe to repeat.** A crash resumes where it stopped; nothing is sent or requested twice.

## What is real and what is not yet verified

- Gemini, the scheduler, the queue, permissions, evidence, approvals, the Digital Twin and Inaya notifications are exercised by automated tests against the real database.
- **Slack and Gmail sending have been verified live** (2026-09-26): a real production run delivered through a Slack incoming webhook and the Gmail API. Slack uses an incoming-webhook URL; Gmail uses an OAuth refresh token you create once. A repeat run on the same day is deduplicated and does not send again.
- **Inaya has no support-ticket module.** The "Get Support Tickets" step reads your own helpdesk through the HTTP connector and has only been tested against a local test server.
- Schedules run from Inaya's five-minute background job, so a schedule fires within about five minutes of its time.

## Set up Slack and Gmail

1. An owner or admin opens **Automations, then Credentials**.
2. For Slack, create an app in your workspace (a ready manifest is provided), turn on Incoming Webhooks, add the webhook to a channel, and store the URL as a **Slack incoming webhook** credential.
3. For Gmail, create a Google Cloud OAuth client of type Desktop app, run the helper script to obtain a refresh token for the sending mailbox, and store the client ID, client secret and refresh token as a **Gmail** credential.
4. Use the **Notification Delivery Test** template to send one message to the inbox, Slack and Gmail before relying on an alert.
