---
slug: customer-portal
title: Customer Portal & Customer Service
description: Let your customers sign in, raise and follow requests, read help articles, ask an AI assistant that only answers from your published knowledge, and suggest ideas, while your team works tickets with queues, SLAs and a full audit trail.
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, support-manager, support-agent, it-admin, auditor]
status: live
version: current
tags: [support, tickets, customer portal, sla, knowledge base, ai assistant, ideas, csat, webhooks, api]
lastVerifiedAt: "2026-09-26"
relatedDocs: [business-workspace, ai-business-operations-manager, security-layer]
---

## What it is

Customer Portal & Customer Service adds a ticketing module and a customer-facing portal to the Business Workspace. Your customers open a portal at `/portal/<your-address>`, sign in with a one-time email link, and can raise requests, follow them, reply, attach files, read help articles, ask the AI assistant, see their invoices and suggest ideas. Your team works the same tickets in **Business Workspace → Customer Support**.

It is built on what Inaya already has, not beside it: customers are your **CRM contacts**, invoices are read from **Finance**, files use the **encrypted storage** layer, every important step is written to the **audit chain** and the **Evidence Graph**, time-driven work uses the same scheduler as **Automations**, and AI goes through the **AI Security gateway**.

## For customers

| You can | How it works |
|---|---|
| Sign in | Enter your email; a single-use link (valid 15 minutes) arrives. No password. The message is the same whether or not the address is known, so nobody can discover who your customers are. |
| Raise a request | Choose what it is about, describe it, optionally attach a file and link one of **your own** invoices. Urgency is decided by policy, not by a priority box. |
| Follow and reply | You see only public messages and a simple status: Open, In progress, Waiting for your reply, Solved, Closed. Internal routing states and notes are never shown. |
| Share with a colleague | Only people your company already knows can be added; you can revoke at any time. |
| Rate the result | One rating per request, after it is solved, from the requester only. |
| Help articles | Search and read what your provider has published. |
| Ask the assistant | Answers come **only** from published articles you may read, with the articles it used. If it cannot answer, it says so and offers to pass the conversation to the team, who receive what was asked and what the assistant already said. |
| Ideas | Suggest an improvement. Ideas are private to you and the team unless the organization enables voting **and** you choose to make yours public (your name is never shown). |
| Invoices | A read-only list from your provider's billing records, with an "Ask about this invoice" shortcut. |

## For your team

| Area | What it gives you |
|---|---|
| Tickets | Statuses with a controlled lifecycle, optimistic concurrency (two people cannot silently overwrite each other), tags, followers, collaborators, relations, merge (nothing deleted), duplicate suggestions, macros, saved views, search across tickets, messages and invoice numbers. |
| Routing | Queues with rules (type, category, priority, channel, customer tier, keywords), teams, and assignment by manual, round-robin, least-loaded, account owner or skills. |
| SLAs | Policies by type, priority, tier and queue. Clocks count **business hours** in your time zone, pause while waiting for the customer or a third party, resume on reply, and are computed from stored timestamps, so a restart or outage cannot lose them. Escalations fire **exactly once**, including catch-up after downtime (marked "late"). |
| Console | Ticket workspace with conversation, internal notes, customer context (CRM contact, tier, history, invoices from Finance), AI triage suggestions, AI reply drafts (you review and send), and quick actions. |
| Email | Reply-by-email that threads with a signed reply address, sender and authentication checks, quarantine for anything unsafe, and loop prevention. |
| Knowledge base | Articles with review and immutable published versions; the author cannot approve their own article (owners/admins excepted); audiences Public, Customers, Agents only; gap detection from repeated tickets. |
| Analytics | Volume, first-reply and resolution times (business hours), SLA compliance, ratings, agents, AI and knowledge metrics. Every figure is computed from recorded data; with no data it says "No data", never zero. |
| Integrations | Signed outbound webhooks with retries, a dead-letter list and redelivery; support API keys; a native **Get Customer Support Tickets** node and updated **Support Escalation** template in Automations. |

## Security model

- **Separate customer domain.** Portal users are bound to one organization and to a CRM contact. A portal session is valid only for its own organization and is refused by every agent route; agent sessions are not customer sessions.
- **Tenant isolation.** The organization always comes from the portal address, the session or the API key, never from a request field. Cross-organization and cross-customer reads return the same "not found" as a missing ticket.
- **Permissions.** Owners and admins hold every support permission. Others get an `agent` or `manager` support role, adjustable per permission (for example export or invoice visibility).
- **Text safety.** Messages are stored and shown as plain text; there is nothing to execute. Files are stored encrypted, downloaded only through permission-checked routes, never rendered inline, and every access is audited. Files are scanned before they are stored (see "Files and virus scanning").
- **AI.** Advisory and never a single point of failure: the ticket is created and routed by your rules first; a slow, blocked or failing model only delays the suggestion, which is retried. Ticket and article text is treated as untrusted data, screened, and never followed as an instruction. AI never closes a ticket, promises a refund or changes an account.
- **Single sign-on** uses OpenID Connect with PKCE and verified ID tokens; it never bypasses the CRM-contact rule.
- **CSRF.** Every mutating portal request needs the `X-Portal-Request` header and a same-origin `Origin`.
- **Webhooks.** HTTPS only; loopback, private and metadata addresses are refused on every attempt; each delivery is signed `X-Inaya-Signature: v1=HMAC-SHA256(secret, timestamp.body)`.

## Set up

1. **Settings → Portal & email**: choose a portal address, switch the portal on, decide who can sign in (only known contacts is the safe default).
2. **Settings → Business hours** and **SLA policies**.
3. **Settings → Agents**: give members the agent or manager role.
4. Optional: **Queues & teams**, **Macros**, the **support email address** and inbound email, AI options, **Webhooks & API keys**.
5. Publish a few knowledge articles (an author submits; another reviewer approves).

## Sharing the portal with customers

**Business Workspace → Customer Support → Portal & sharing** is the administrator's entry point. It shows your portal link (with a copy button and an "Open the portal" button), a set-up checklist, a QR code, an email-signature line, a ready-made "Get support" button for your website, and the short form `/support/<portal address>`. Customers who only know your company name can go to **Get support** in the footer of the Inaya site (`/support`), enter your portal address and land on your portal. There is no public directory: portals are private to each company's customers.

A customer can sign in and submit a request themselves when they are in your CRM contacts (the safe default), or when you choose **open sign-up** (anyone with a working email; a CRM lead is created). Customers who prefer to look first can read the help articles without signing in.

## Sign in with your company account (single sign-on)

**Settings → Sign-in & security** lets an administrator connect any OpenID Connect provider (Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak). Enter the issuer, client ID and client secret (stored encrypted), optionally limit sign-in to certain email domains, then register the redirect URI shown by **Test the provider connection** with your provider. The flow uses the authorization-code grant with PKCE, a single-use `state` and a `nonce`; the ID token's RS256 or ES256 signature is verified against the provider's published keys, and issuer, audience, expiry and nonce are checked. The provider must say the email is verified (you may relax this for providers that do not send the claim). SSO proves who someone is; they must still be a CRM contact (or open sign-up must be on). Email links keep working alongside SSO.

## Files and virus scanning

Attachments can be up to **25 MB** (you can set a lower limit). Larger-than-request files are sent in 3 MB chunks and verified with a SHA-256 checksum before storage. Every file, however it arrives (portal, console, API, email), goes through:

1. **Policy checks:** allowed types, blocked executables and scripts, double extensions, content that does not match its name.
2. **Built-in static inspection:** the EICAR test signature, executables hidden in documents, archive inspection (executables inside, password-protected entries that cannot be inspected, nested archives, path traversal, zip bombs, entry counts), Office macros (modern and legacy), ActiveX and embedded executables, PDF JavaScript / Launch / embedded files (including obfuscated names), and scripts hidden in images.
3. **An antivirus engine, if the platform operator connected one:** a ClamAV daemon (`CLAMAV_HOST`, `CLAMAV_PORT`; the file never leaves your network) and/or the Cloudmersive Virus Scan API (`CLOUDMERSIVE_API_KEY`; the file is sent to that service). If a connected engine cannot answer, the file is refused rather than assumed clean.

Refused files are never stored, and the refusal is recorded in the audit trail. **Static inspection is not a signature-based antivirus.** Until an engine is connected, the console shows "Virus scanning: built-in only". Administrators can choose **strict** mode, which refuses files whenever no engine can check them.

## Email

**Outbound:** sign-in links and ticket updates are sent through Resend with safe threading headers. *Portal & sharing* shows whether outbound email is configured and has a **Send a test to me** button.

**Reply-by-email (recommended setup):** the platform operator receives mail for one inbound domain in Resend and points a Resend `email.received` webhook at `POST /api/support/inbound-email/resend`. Set `SUPPORT_INBOUND_DOMAIN` (the receiving domain), `RESEND_WEBHOOK_SECRET` (the webhook signing secret, `whsec_...`) and make sure `RESEND_API_KEY` can read received email. Each portal then receives mail at `<portal address>@<inbound domain>` and ticket emails carry a signed reply address `<portal address>+<ticket token>@<inbound domain>` with no per-organization setup. The webhook's Svix signature is verified (5 minute tolerance), the message is fetched with the Resend API, routed by the recipient address and processed like every other channel: idempotent by Message-ID, threaded only by the signed reply address or stored Message-IDs, the sender must be a participant and pass DKIM/DMARC (evidence is read from the receiving side's authentication headers; **no evidence counts as failed**), and anything else is quarantined for a person to review.

**Your own relay (alternative):** create an inbound secret in Settings and post parsed messages as JSON to `POST /api/support/inbound-email/<portal address>` with `X-Inaya-Timestamp` (Unix seconds, within 5 minutes) and `X-Inaya-Signature` (hex `HMAC-SHA256(secret, timestamp + "." + rawBody)`).

## Public API

Create a support API key in **Settings → Webhooks & API keys**. Keys carry named scopes, expire, can be revoked, and can be tied to one customer. A support key cannot open any other API. Endpoints live under `/api/public/v1/support` (see the API reference), including chunked uploads for large files. Creating a ticket honours `Idempotency-Key`.

## Limits

- No telephony, WhatsApp or SMS channels.
- Attachments are limited to 25 MB each.
- Invoices are read-only and show the fields Finance stores; Inaya has no "outstanding balance" field to show.
- A message's text is stored as plain text; rich formatting in email is reduced to text.
