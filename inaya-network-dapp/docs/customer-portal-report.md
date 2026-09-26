# Customer Portal & Modern Customer Service: implementation report

Scope: `Inaya_Customer_Portal_Modern_Customer_Service_SOW.md` (73 sections), including the ticket module, which did not exist in Inaya and was built as the core of this work. The Phase 0 audit is in `CUSTOMER_PORTAL_CAPABILITY_AUDIT.md`. Product documentation: `content/docs/products/customer-portal.md`. API reference: `src/lib/docsApiReference.js` and `public/openapi.json`.

## What was built

| Layer | Where |
|---|---|
| Domain libraries (30 collections) | `src/lib/support/*.js`: `db`, `common`, `settings`, `access`, `sla`, `slaTick`, `tickets`, `messages`, `queues`, `customers`, `attachments`, `portalAuth`, `inbound`, `kb`, `ideas`, `csat`, `ai`, `analytics`, `webhooks`, `apiKeys`, `incidents`, `macros`, `exporter`, `retention`, `record`, `notify`, `flows`, `runner` |
| Dispatchers | `agentApi.js` (console/admin), `portalApi.js` (customers), `publicApi.js` (API keys) |
| Routes | `/api/orgs/support/**` (+ `upload`, `attachments/[id]`, `export`), `/api/portal/[slug]/**` (+ `upload`, `attachments/[id]`), `/api/public/v1/support/**`, `/api/support/inbound-email/[slug]`, `/api/cron/support` (every 5 minutes) |
| Agent console | `src/components/business/SupportView.js`, `support/panels.js`, `support/settings.js`; nav item "Customer Support" |
| Customer portal | `src/app/portal/[slug]`, `src/components/portal/PortalApp.js` (responsive, keyboard and screen-reader friendly, light/dark) |
| Automations integration | `data.inaya_support_tickets` node, `support` data scope, updated Support Escalation template (the Daily Business Health template keeps its optional external-helpdesk step; the native node can be swapped in) |

## Reuse, not duplication

Customers are `crm_contacts`; invoices are read from `invoices` (never copied); files use the S3-compatible encrypted store with provider fallback; audit uses `logOrgActivity`; the Evidence Graph gets a `SUPPORT_TICKET` subject with typed relationships; notifications use `createNotification`; AI goes through the AI Security gateway and the existing `callModel` seam; time-driven work follows the Automations cron pattern; outbound email uses `sendEmail` (extended with headers and reply-to).

## Verification

Real MongoDB, real audit chain, real route handlers. Only the model provider is scripted (the existing `__setAiProvider` seam) and webhook receivers are local HTTP servers.

| Suite | Covers |
|---|---|
| `support-sla.test.mjs` | Business-hours arithmetic (nights, weekends, holidays, time zones), pause/resume, thresholds, downtime determinism |
| `support-unit.test.mjs` | Text safety, quoted-reply stripping, address parsing, lifecycle rules, customer-safe statuses, undefined-id filter guard, priority policy, similarity, attachment policy, webhook SSRF rules, reply-token signing, macros, AI input minimization, permissions, safe defaults, CSRF guard |
| `support-core.test.mjs` | Login enumeration safety and single-use links, ticket creation/routing/SLA/AI triage, notes never reach customers, cross-tenant and cross-customer isolation, lifecycle, AI outage and retry (§62), prompt injection, knowledge chat with citations and handoff (§63), ideas privacy and voting, CSAT, analytics with no data, API key scopes |
| `support-routes.test.mjs` | Full customer journey (§58), CSRF, agent permissions and tenancy (§57), public API contract and idempotency (§64), inbound email signature, threading and hijack attempts (§60), attachments over HTTP, export, cron |
| `support-live-ai.test.mjs` | The real Gemini model through the real AI Security gateway: valid triage suggestion, injected instruction ignored, chat answers from a published article with a genuine citation and hands off a question the knowledge base does not cover. The model network is slow and occasionally drops, so the test retries triage exactly as the cron worker does |
| `support-scanner.test.mjs` | Malware and active-content screening, and the ClamAV and Cloudmersive adapters against protocol-accurate local servers |
| `support-hardening.test.mjs` | Chunked uploads end to end, SSO against a local OIDC provider, Resend inbound (Svix signatures, routing, authentication, attachments), administrator status |
| `support-integrations.test.mjs` | Signed webhooks with retry and dead-letter, SLA escalation exactly once after downtime and under concurrent workers (§61), auto-close, merge, sharing, knowledge versions and audiences, quarantine review, retention with legal hold, export safety, workflow integration |

Results on 2026-09-26: 56 non-live checks passing (8 SLA, 16 unit, 15 core, 6 routes, 11 integrations), 2 live-model checks passing, and regression suites for Automations, docs/OpenAPI, API keys, Business Events and audit chain unaffected. The customer portal and agent console were also exercised in a browser against a seeded organization (sign-in by link, request list, ticket thread hiding internal notes, console ticket workspace with customer context and Finance invoice).

## Gap closure (second pass, 2026-09-26)

| Gap | What was built | How it was verified |
|---|---|---|
| Users could not easily find or reach the portal | **Portal & sharing** tab in the console (portal link, open button, checklist, QR code, email-signature line, website button, live status); public **Get support** page (`/support`, `/support/<address>`) linked from the site footer; the signed-out portal shows a clear sign-in card, SSO button and browse-articles link | Console and portal exercised in a browser; routes covered in tests |
| Inbound email unverified against a provider | Resend inbound adapter: Svix signature verification, message fetch through the Resend API, routing by `<portal address>@<inbound domain>`, signed reply addresses on the platform domain, DKIM/DMARC evidence read from the receiving side's headers (no evidence = failed = quarantined), attachments scanned. The signed generic relay remains for organizations with their own mail flow | Real Svix signing and hostile-message cases against the adapter with the Resend API stubbed. **Not yet exercised against live Resend** (needs the operator's Resend receiving domain, webhook and `RESEND_WEBHOOK_SECRET`) |
| Outbound email unconfirmed | `RESEND_API_KEY` and `EMAIL_FROM` are set in Vercel production. A **Send a test to me** button in the console proves delivery from the live site | The key is a Vercel sensitive variable and cannot be read locally, so live delivery is confirmed by using that button on production |
| No antivirus | Built-in static inspection on every file (EICAR, executables, archives, macros, PDF active content, polyglots) plus optional real engines: ClamAV daemon (INSTREAM) and Cloudmersive; strict mode; fail-closed when a configured engine cannot answer; scan record stored per file; refusals audited | 10 scanner tests with crafted files and protocol-accurate local engine servers; end-to-end upload tests including EICAR and PDF-JavaScript refusal. **No real engine was connected**, so signature-based detection is available only once an operator supplies `CLAMAV_HOST` or `CLOUDMERSIVE_API_KEY` |
| No customer SSO | OpenID Connect authorization-code flow with PKCE, single-use `state`, `nonce`, own RS256/ES256 verification against the provider's keys, domain allow-list, verified-email requirement, encrypted client secret, console configuration and connection test, portal button | Tested against a local identity provider that signs real RS256 tokens: valid login, replay, non-contact, wrong key, `alg: none`, HS256 confusion, wrong audience/issuer, expired, wrong nonce, unverified email, cross-organization state, domain allow-list. **Not tested against Google/Microsoft/Okta live** |
| 4 MB attachments | Chunked upload (3 MB chunks) up to 25 MB for portal, console and API, with size/type checks before any bytes move, SHA-256 verification, idempotent chunks, ownership-bound tokens and TTL cleanup | 7 MB file round-trip through encrypted storage; refusal cases; agent and API-key surfaces |

## Honest limits

- **Inbound email through Resend** and **SSO with a real identity provider** are implemented and tested against stand-ins, but not against the live services: each needs a step only the operator can do (Resend receiving domain and webhook; an OAuth client at the identity provider).
- **Antivirus:** built-in inspection is real but is not signature-based antivirus. A real engine is used only when configured.
- **Outbound email** delivery is confirmed by the console's test button on the deployed site.
- No telephony, WhatsApp or SMS channels.
- Attachments are limited to 25 MB.
- **Invoices** show the fields Finance stores; there is no "outstanding balance" field.
- **AI** is advisory. Its output is never the single point of failure and never takes a business action.
- Ticket volume performance beyond a few thousand tickets per organization has not been load-tested.
