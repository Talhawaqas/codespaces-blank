# Inaya Connect (WhatsApp Business & AI Gateway) — Phase 0 audit

SOW: INAYA-CONNECT-SOW-2026-01. Audited 25 Nov 2026 against `inaya-network-dapp` main @ 43f8b8c. Audit only; no code changed.

## 1. What already exists (reuse)

| SOW need | Existing | Decision |
|---|---|---|
| Meta webhook (GET verify challenge, POST `X-Hub-Signature-256` HMAC over the raw body) | `src/lib/bookkeeper/inbound.js` `whatsappVerify` / `whatsappReceive`, route `/api/finance/bookkeeper/whatsapp/[sourceId]`, rate-limited | **Reuse the verification code**, move to one platform webhook routed by verified phone-number ID (SOW B2). The bookkeeper source stays working. |
| Per-company WhatsApp credentials (phone-number ID, app secret, token) encrypted at rest | `bookkeeper/sources.js` (type WHATSAPP, secrets via `integrationCrypto`) | **Reuse the encryption**; connection becomes a company-level Inaya Connect record. |
| Media download from the Graph API | `bookkeeper/inbound.js` (media URL → bytes) | **Reuse** |
| File validation + malware scan + quarantine | `support/attachments.js` `checkFile`, `support/scanner.js` (static + engine) | **Reuse** |
| Document classification / extraction | `docIntelligence/*` (analyze, extract, review) | **Reuse** |
| Bills/receipts into review (never auto-approved) | `bookkeeper/documents.js` `ingestDocument` → DRAFT + review queue | **Reuse**: invoices/receipts land in AI Bookkeeper review, as SOW C3 requires |
| Encrypted document storage | encrypted object store (`s3-compat`, key now set in production) | **Reuse** |
| Permission-scoped business AI | `ai-business-tools.js` (scope from real membership; 39 tools; `propose_*` never mutate, they create approval requests) | **Reuse** as the Business Operations Assistant engine |
| AI security (prompt-injection, PII screening, output validation) | `aiSecurity/gateway.js`, `promptInjection.js` | **Reuse** |
| Conversation inbox, assignment, AI pause/hand-over, internal notes, business hours, SLA | Customer Portal / support desk (`support/*`: tickets, chat hand-over, agents, queues, business hours) | **Reuse**: a WhatsApp conversation is a support conversation on channel WHATSAPP |
| Customer identity domain separate from staff | `support/portalAuth.js` (portal users ↔ CRM contact, magic links) | **Reuse** for customer verification |
| Customer self-service data | Manage Orders (WO/RO status), sales orders, appointments, invoices, portal requests | **Reuse** via new read-only customer tools |
| Notifications, audit, webhooks out, rate limits, cron | `notifications.js`, `org-activity-log.js`, `webhooks/registry.js`, `rateLimit.js`, Vercel cron | **Reuse** |
| Branch scoping | `workforce/scope.js` | **Reuse** in every new tool |

## 2. Gaps (to build)

1. **Inaya Connect connection record** per company (phone-number ID, WABA ID, display number, status, health, token expiry), with a platform webhook `/api/connect/whatsapp` that resolves the tenant ONLY by the verified phone-number ID and rejects unknown, revoked or mismatched IDs.
2. **Message ledger**: inbound/outbound messages and statuses, idempotent on WhatsApp message ID, out-of-order status handling, retries.
3. **Sender resolution**: staff (Business OS member linked by a verified phone), customer (CRM contact, verified per session), supplier (allow-list), unknown.
4. **Business assistant tools missing today**: sales totals by period/branch (from POS and orders), stock for a product at my branch, orders waiting to dispatch, work/repair-order status, who is scheduled today, overdue invoices summary. All read-only and branch-scoped.
5. **Customer assistant tools**: my order, my repair, my appointment and my invoice status after verification, and FAQs from published help articles.
6. **Customer verification**: one-time code to the contact's registered email (or an order reference plus a second factor), short-lived and single-use.
7. **Document routing rules**: category → destination (Bookkeeper bills, expenses evidence, procurement, goods receiving, customer case) with a review queue for low confidence.
8. **Outbound sender** (Cloud API) with the 24-hour customer-service window, template support, opt-out/suppression, per-company usage counters and limits.
9. **Admin area** "Inaya Connect" in Business OS: connect/test/disconnect, health, assistants on/off, staff and branch scope, routing rules, verification policy, hours and greetings, limits and usage, audit and errors.
10. **Monitoring**: rejected events, failures, permission-denied, verification outcomes, duplicate suppression.

## 3. Constraints

- **No new collections** (Atlas at 500): records go in `calendar_records` as `wa_*` kinds; one new partial index for routing by phone-number ID (calendar_records now has 42 of 64).
- **Webhook is public on production only** (`https://www.inayanetwork.com/api/connect/whatsapp`). No tunnels or local public servers (company EDR rule). Local tests use signed sample payloads.
- **Meta is an external dependency** (Section 4). The live 100% gate needs real WhatsApp numbers.

## 4. Meta onboarding dependencies (owner side)

1. Meta Business Portfolio for Inaya Network, **business verification** completed.
2. Meta developer app (type Business) with the WhatsApp product; a **system user** and permanent token for Inaya's own test number.
3. For customers connecting their own numbers in one click (**Embedded Signup**): Inaya must become a **Tech Provider** and pass **App Review** for `whatsapp_business_management` and `whatsapp_business_messaging`. This takes days to weeks and is not guaranteed.
4. Until that is approved, a company can still connect by entering its own phone-number ID and system-user token from its own Meta setup (the model the Bookkeeper source already uses). This is the proposed first-release path; Embedded Signup is added when Meta approves.
5. **Two WhatsApp numbers** (two test companies) for the tenant-isolation acceptance tests (SOW 8.1).
6. Pricing: Meta's current rate card and message categories (marketing/utility/authentication/service) must be read at build time; Inaya shows estimates and never promises free messaging.

## 5. Threat model (summary)

Spoofed webhooks (signature check with the app secret), tenant confusion (route only by stored verified phone-number ID), replay (message-ID ledger), prompt injection in messages and documents (AI security gateway, documents treated as data, tools enforce scope server-side), customer impersonation by phone number (verification required for any personal record), cross-tenant cache (no shared context), token leakage (encrypted, redacted from logs/UI), floods (per-number and per-sender rate limits), malicious files (scan + quarantine), and AI competing with a human (pause on take-over).

## 6. Phased plan (SOW §7)

1. **Phase 1:** connection (manual first, Embedded Signup when approved), platform webhook, tenant routing, message ledger, outbound text, status handling, admin connect/test/disconnect.
2. **Phase 2:** document intake: media download, validation, scan, quarantine, hash dedup, classification, routing rules, Bookkeeper/procurement/goods-receiving review, acknowledgement.
3. **Phase 3:** Business Operations Assistant: staff phone linking (verified code), new read-only tools, branch scope, period/currency/timezone context, read-only policy with `propose_*` hand-off.
4. **Phase 4:** Customer Assistant: verification, my-records tools, FAQs, hand-over, opt-out.
5. **Phase 5:** inbox integration with support desk, hours, usage limits, templates, dashboards, recovery tests, docs.

Each phase: automated tests on the test database, then live tests on the founder company with real WhatsApp numbers; production only after 100% and owner sign-off. Hidden behind `FEATURE_INAYA_CONNECT` until then.
