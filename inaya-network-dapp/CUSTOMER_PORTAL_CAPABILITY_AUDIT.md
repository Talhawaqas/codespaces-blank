# Customer Portal & Customer Service — Capability Audit (SOW §2, Phase 0)

Method: read the repository (`src/lib`, `src/app`, `content/docs`) before designing. Status vocabulary from the SOW:
**Existing** · **Reusable** · **Partial** · **Missing** · **Unverified** · **External dependency** · **Not appropriate**.

## 1. Findings

| Capability the SOW needs | Status | Where / what it means for this build |
|---|---|---|
| Tickets, queues, teams, SLAs, agent console | **Missing** | No customer-service code exists. `incidents.js` is an internal security-incident register, `guided-tasks.js` is an assistant feature: neither is a ticket system. Built new (`src/lib/support/`). |
| Organization identity, membership, roles | **Reusable** | `orgs.js` (`requireMembership`, `getMembership`), role gates in `orgGates.js`. Support roles follow the exact `financeRole`/`hrRole`/`nasRole` precedent (`supportRole` field). No parallel employee identity. |
| Customer (portal) identity | **Missing** | Members and wallets exist; an org's *customers* have no login. Built a separate security domain: magic-link portal users mapped to CRM contacts, own session cookie, own tables. Not a second employee identity. |
| CRM contacts / customers / companies | **Reusable** | `crm_contacts` (email, company, name, type). A portal customer is mapped to a CRM contact by verified email; no CRM record is duplicated. `crm_deals` linked for context. |
| Invoices and billing | **Reusable** | `invoices` (number, dates, total, currency, status, contactId). The portal reads them read-only, scoped to the customer's own contact. No second invoice model. **Gap documented:** no per-invoice "outstanding balance" field (payments live in `payments`); the portal shows status and total and reports payments only if recorded. |
| AI gateway and AI permission model | **Reusable** | `aiSecurity/gateway.js` (`checkInputSecurity`, `validateOutput`), prompt-injection/PII detectors, Gemini via `@google/genai`, `workflows/ai.js#callModel`. Support triage, chat and drafting call this; no second gateway. |
| Cryptographic audit trail | **Reusable** | `logOrgActivity` → `audit_chain_entries`. |
| Evidence Graph | **Reusable / Partial** | `businessEvents.js` subject registry. Added subject `SUPPORT_TICKET` (additive, same pattern as NAS and workflows). Graph visibility for tickets is org-manager-only (existing `canViewEvent` rule). |
| Digital Twin | **Reusable (not used)** | Not needed for ticketing; no second engine created. |
| Internal notifications | **Reusable** | `notifications.js` (`createNotification`, unique `dedupeKey`, org scope). |
| Customer notifications | **Partial** | Customers are neither org members nor wallets, so `createNotification` cannot address them. A small customer-notification store with the same dedupe discipline was added; email goes through the existing `sendEmail`. |
| Outbound email | **Reusable / Partial** | `email.js#sendEmail` (Resend). Extended additively with `headers` and `replyTo` (needed for safe threading). |
| Inbound email | **Missing / External dependency** | No inbound mail handling exists. Built a provider-neutral, HMAC-signed inbound endpoint that accepts a normalized message (works with Resend inbound, Postmark, SendGrid, Mailgun via a thin forwarder). **Unverified against a real inbound provider** until an inbound address is configured. |
| Attachments / storage | **Reusable** | `s3-compat/store.js#putS3Object` (server-managed encryption, sharding, pinning, provider fallback) and `getS3ObjectBody`. Attachments are stored as objects in a per-org `support-attachments` bucket; ticket records hold references only. Note: the bucket is visible to holders of the org's S3-compatible credentials (org-level admin access). No antivirus engine is available: policy-only scanning (type/size/magic-byte checks), recorded honestly. |
| Knowledge base and search | **Partial** | `rag/*` and `content/docs` are Inaya's *own* product documentation, not per-org content. `orgSearch.js` searches business records. A per-org KB (articles, versions, review states, feedback) is new; search uses a MongoDB text index. |
| Public API and API keys | **Partial** | `api-keys.js` keys are org-bound but unscoped owner-level. Added **support-kind keys** (scoped, expiring, optionally bound to a portal customer) in the same collection, and made the legacy `requireApiKey` refuse them so a customer key can never open an existing owner-level public route. |
| Webhooks (outbound) | **Missing** | Inbound HMAC webhooks exist for workflows; outbound support webhooks (signed, retried, dead-lettered) are new. Reuses the workflow HTTP SSRF guard. |
| Automation / workflows | **Reusable** | The Automations engine (`src/lib/workflows`). Support events are emitted as workflow events, and the "Get Support Tickets" workflow node now reads native tickets (closing the gap noted in the Automations report). |
| Scheduler / queue | **Reusable** | Vercel cron (paid plan, every 5 minutes) pattern; SLA scheduling is DB-driven and recalculated on every pass, never an in-memory timer. |
| Rate limiting | **Reusable** | `rateLimit.js#checkRateLimit`. |
| Status / incident page | **Missing** | No public status system exists. Per SOW §36 this is an optional extension: a minimal manual announcements/incidents banner (no monitoring) is provided and labelled as such. |
| Customer SSO (Google/OIDC) for the portal | **Not built (audit decision)** | SOW §41 lists these as *possible* modes subject to audit. Existing Google/OIDC code is for org members. The portal ships magic-link sign-in (safest existing pattern, no passwords). |
| Real inbound email provider, real customer mailbox | **External dependency** | Outbound email is real (Resend key is set in production); inbound needs a provider account/DNS. |
| Telephony, WhatsApp/SMS/social | **Not appropriate / out of scope** | Explicit non-goals in SOW §4. |

## 2. Design decisions that follow from the audit

1. New tables only for genuinely missing concepts; all business context (contacts, invoices) is read from the existing collections.
2. Two separate security domains: **agents** use the organization session (`requireMembership` + support role); **customers** use a portal session that is valid for exactly one organization and can only ever read that customer's own records.
3. Every consequential ticket event is written to the existing audit chain; ticket lifecycle enters the Evidence Graph as subject `SUPPORT_TICKET`.
4. AI is advisory: it never makes an unreviewed consequential change, never receives another customer's data, and is never a single point of failure (a ticket is created first, triage is retried later).
5. SLAs are computed from stored business-calendar data and stored timer segments; a scheduler pass recomputes and applies each missed escalation exactly once through a unique ledger.

## 3. Things this SOW asks for that are documented as limits, not faked

- Malware scanning (no engine): policy checks only.
- Real inbound email and customer SSO: not verified / not built (above).
- Attachments larger than about 4 MB (the hosting platform's request-size limit).
- "Outstanding balance" (no field in the invoice model).
