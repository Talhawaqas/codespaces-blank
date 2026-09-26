# AI Bookkeeper: Implementation Report

SOW: *AI Finance & Bookkeeping Automation Layer*. Phase 0 audit and gap matrix: [`AI_BOOKKEEPER_CAPABILITY_AUDIT.md`](../AI_BOOKKEEPER_CAPABILITY_AUDIT.md). User guide: `content/docs/products/ai-bookkeeper.md`.

## What was built (all under `src/lib/bookkeeper/`, routes and UI listed below)

| SOW section | Implementation |
|---|---|
| 6, 7 Sources, bank abstraction | `sources.js` (bank account, upload, email relay, API, WhatsApp; one department each; secrets encrypted, shown once), `bank.js` (CSV and OFX/QFX parsers, duplicate-safe import with occurrence-aware fingerprints, provider adapter interface with **no provider registered**). |
| 8, 11 Ingestion, extraction | `documents.js` (size, type, magic-byte, filename checks, malware scan via the existing scanner, SHA-256 duplicate check, encrypted storage with retries), `extract.js` (text PDFs through `unpdf`, deterministic field extraction with line/snippet provenance, arithmetic validation, AI path through the existing AI gateway, grounded-value rule, injection detection). |
| 9, 10 Email, WhatsApp | `inbound.js` + routes `/api/finance/bookkeeper/ingest/:source` and `/whatsapp/:source`: HMAC signatures, 5-minute window, event-id replay guard, sender allow-lists, business-number check, media fetch through Graph with the stored token, retry semantics. |
| 12, 45, 46 Categorization, rules | `categorize.js`: rule > approved mapping > history > AI, versioned audited rules, learned mappings that never rewrite history. |
| 13-16 Matching, reconciliation, three-way | `match.js` (named signals, reproducible scores, partial/over/fees/currency/combined), `reconcile.js` (idempotent run, review routing, RECONCILED sweep), `threeWayMatch` over real PO items and received quantities. |
| 17, 18, 36 Duplicates, exceptions, anomalies | `documents.js` (file and identity duplicates), `anomaly.js` (explainable signals, mandatory wording). |
| 19, 48 Policy | `policy.js`: four confidence dimensions, configurable thresholds, risk overrides confidence. `settings.js`: validated, versioned, audited. |
| 20 Review queue | `review.js`: all ten actions, permission gates, audited, learning. |
| 22, 23 Posting boundary | `reconcile.js`: recorded payments, draft expenses, "mark paid" only PROPOSED through the existing Controlled Actions. **No general ledger exists; none was invented.** |
| 24-26 Dashboard, table, reports | `insights.js`; UI `BookkeeperView` (9 tabs). CSV reports with metadata and formula-injection protection. |
| 27 Period close | `period.js`: checklist and a "reviewed" marker, explicitly not a statutory close. |
| 28 Business Insights | `bookkeeping` block added to `computeBusinessInsights`, same permission scope. |
| 29, 30, 37 Evidence, events, audit | `record.js`: existing audit chain (`BOOKKEEPING`), Evidence Graph subjects `BOOKKEEPING_TRANSACTION` / `BOOKKEEPING_DOCUMENT`, all 18 event types, Business Event Passport through the existing builder. |
| 31 Notifications | Finance-capable members only. |
| 32 Assistant | `get_bookkeeping_status` tool for the existing AI Business Assistant (`assistant.js`). |
| 33, 59 Workflows | Node types `data.bookkeeping` and `action.bookkeeping_run` plus the **Finance Operations Manager** template in the existing workflow engine. No second scheduler. Safety-net cron `/api/cron/bookkeeper` (15 min) for retries only. |
| 34, 56 Digital Twin | `twin.js`: three read-only scenarios labelled SIMULATED; proven to write nothing. |
| 35 Security | See tests below. |
| 43 Observability | `insights.js#observability`, counted from stored records. |

Existing files touched (additive): `orgs.js` (two collection handles), `businessEvents.js` (two subject types), `digitalTwinSimulate.js` (three scenarios), `business-insights.js` (bookkeeping block), `ai-business-tools.js` (one read-only tool), `workflows/{nodes,data,engine,templates}.js` (two node types, one template), `vercel.json` (cron), `business/page.js` (nav). New dependency: `unpdf` (text extraction from PDFs).

## Acceptance scenarios (SOW sections 54-56)

| Scenario | Test |
|---|---|
| A Supplier invoice (email relay, PO, payment, provenance, no duplicates) | `bookkeeper-flow` A |
| B Customer payment (mark paid only proposed) | `bookkeeper-flow` B |
| C WhatsApp receipt | `bookkeeper-security` WhatsApp |
| D Low confidence (no auto-post, audited correction) | `bookkeeper-flow` D |
| E Duplicate invoice | `bookkeeper-flow` E |
| F Suspicious payment | `bookkeeper-flow` F |
| 55 End-to-end evidence | `bookkeeper-flow` A (Evidence Graph relationships, audit trail, chain verifies) |
| 56 Digital Twin | `bookkeeper-flow` (simulations change no record) |

Also covered: idempotency (re-import, re-reconcile, replayed webhooks, repeated confirmation), organization and department isolation, revoked membership, credentials never in views/audit/notifications/evidence, malicious files (EICAR, executables, magic-byte mismatch, traversal, NUL bytes, oversize), prompt and tool injection, CSV formula injection, HTTP auth and idempotency keys.

## What is NOT verified

- **Live email provider:** only the signed relay was tested. Gmail, Microsoft 365 and IMAP polling are FUTURE.
- **WhatsApp:** tested against a stand-in for Meta's Graph API and webhook contract. UNVERIFIED against a real WhatsApp Business account.
- **Live bank feeds:** not available (no provider). Statement import only.
- **OCR:** no local OCR engine. Images and scanned PDFs depend on the configured AI model and are never auto-processed. The AI paths were tested with a scripted model, not a live one.
- **Ledger and statutory close:** not built.
- **Excel/PDF exports:** not offered.
- **Payments and expenses are USD-oriented** in existing Inaya code; the bookkeeper preserves the bank transaction's currency on the payments it records.
- The reference image's "$20,000 saved" claim is not reproduced anywhere; no savings are estimated.

## Operating notes

No new required environment variable. Uses `INTEGRATION_ENCRYPTION_KEY` (source secrets) and `CRON_SECRET`. AI extraction/categorization use the existing AI gateway (`GEMINI_API_KEY`); without it the bookkeeper still works and sends items to review. `WHATSAPP_GRAPH_BASE_URL` exists only so tests can point at a stand-in.
