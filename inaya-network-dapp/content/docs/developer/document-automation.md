---
slug: document-automation-developer
title: Document Automation — Developer, API & Template Guide
description: Architecture, the HTTP API, the safe template language, evidence and verification internals, and how to add a new document type.
product: Developer Platform
category: guide
contentType: Reference
audience: [developer, integration-partner]
status: live
version: current
tags: [documents, api, templates, evidence, pdf]
lastVerifiedAt: "2026-09-25"
relatedDocs: [document-automation, developer-overview]
---

## Architecture

```
Inaya data -> Template -> Calculation -> Document -> Validation -> Approval
   -> Evidence -> Encrypted storage -> Secure delivery -> Verification
```

One pipeline (`src/lib/documentAutomation/pipeline.js`) serves every document type through a registry (`documentTypes.js`) composed of: a **DataAdapter** (`adapters.js`), a **Template** (`templateStore.js`, `systemTemplates.js`), a shared **Renderer** (`renderer.js`), a **Validator** (`validators.js`), a **CalculationPolicy** (`calculations.js`), an **ApprovalPolicy** (`settings.js` + `lifecycle.js`), a **StoragePolicy** (`storage.js`), a **DeliveryPolicy** (`delivery.js`) and an **EvidencePolicy** (`evidence.js`). Nothing branches on a document type name.

It reuses — and does not rebuild — Finance/CRM/Procurement records, the org permission gates, the Segregation-of-Duties checker, the notification and audit-chain infrastructure, the S3-compatible encrypted storage path (server-managed AES-256-GCM, sharded, pinned), the Object Lock/retention layer, the document share tokens, the external Data Room identity, the Evidence Graph (`businessEvents.js`) and the guarded AI-action path.

## Money

All arithmetic is exact BigInt decimal (`money.js`, `calculations.js`): values are parsed once into 10^-8 fixed point, results are integer minor units with a named rounding mode (`HALF_UP`, `HALF_EVEN`, `DOWN`, `UP`), currency precision comes from a table (USD/EUR/GBP/AED/PKR = 2, JPY = 0, KWD/BHD/OMR = 3), and an invoice-level discount is allocated pro-rata by largest remainder so parts sum exactly. The result's `_minorUnits` is what the `calculationHash` covers; the PDF is rendered from it and nothing else.

## Identity, hashes and the manifest

| Field | Meaning |
|---|---|
| `documentHash` | SHA-256 of the exact PDF bytes |
| `sourceDataHash` | canonical hash of the authorized source snapshot |
| `templateHash` | canonical hash of the template spec used |
| `calculationHash` | canonical hash of the minor-unit calculation |
| `evidenceRoot` | head of the document's evidence-node chain when finalized |
| `manifestHash` | canonical hash of the whole manifest |

Anything hashed **and** stored goes through `jsonSafe()` first, because the MongoDB driver stores `undefined` as `null`. For documents requiring approval the approver sees a *draft* render; finalization re-renders with the approval stamp, so the manifest records both `draftDocumentHash` (approved) and `documentHash` (final).

## Lifecycle

`DRAFT → GENERATED → PENDING_APPROVAL → APPROVED → FINALIZED → DELIVERED → VIEWED → PAID`, plus `REJECTED`, `VOID`, `CANCELLED`, `EXPIRED`, `SUPERSEDED`. Transitions are atomic status-guarded updates (`lifecycle.js`). Operational `pipelineState` is separate: `GENERATING`, `GENERATION_FAILED`, `STORAGE_PENDING`, `STORAGE_FAILED`, `EVIDENCE_PENDING`, `FINALIZING`, `DELIVERY_FAILED`, `COMPLETE`. A document is never `GENERATED` unless storage succeeded and never `COMPLETE` unless its evidence chain is written.

## HTTP API

All `/api/orgs/documents-automation/*` endpoints use the session cookie, derive the organization membership from `orgId` (never trusting a client role), enforce the relevant permission, rate-limit per user, and audit. Base: `/api/orgs/documents-automation`.

| Method & path | Purpose |
|---|---|
| `GET /types` | Document-type registry, template list, the template language |
| `GET /sources?orgId&documentType` | Records the caller may generate from |
| `POST /preview` | Watermarked preview PDF (base64), calculation, validation. No number, nothing stored |
| `GET /documents` | Permission-aware list/search (`q`, `documentType`, `status`, `sourceRecordId`, `limit`, `skip`) |
| `POST /documents` | Generate `{orgId, documentType, sourceId, options?, templateId?, templateVersion?, locale?, pageSize?, idempotencyKey?, forceNewVersion?}` |
| `GET /documents/{id}` | Status, calculation, checks, manifest |
| `GET\|POST /documents/{id}/approval` | Approval package (with drift check) / `{action: request\|approve\|reject, note}` |
| `POST /documents/{id}/finalize` | Finalize |
| `POST /documents/{id}/void` | `{reason}` void a finalized document, or `{cancel:true}` cancel an unfinalized one |
| `POST /documents/{id}/retry` | Retry a failed storage/evidence step |
| `GET /documents/{id}/download?stage=final\|draft` | Decrypted PDF for an authorized viewer (hash re-checked) |
| `GET /documents/{id}/history` | Evidence chain, versions, deliveries, access log, Evidence Graph timeline |
| `GET\|POST /documents/{id}/explain` | Auditable inputs/rules/evidence; advisory summary |
| `POST /documents/{id}/verify?deep=1` | Recompute hashes/chains; optional PDF body |
| `GET /documents/{id}/passport?scope=internal\|external&format=json\|pdf` | Document Passport |
| `GET\|POST /documents/{id}/deliveries`, `DELETE …/{deliveryId}` | Secure link / Data Room delivery and revocation |
| `GET\|POST /templates`, `GET\|PATCH\|DELETE /templates/{id}`, `GET\|POST …/versions`, `POST …/publish` | Template CRUD and versioning |
| `GET\|PUT /settings` | Numbering, approval policy, defaults, billing profile, retention |
| `GET /numbers?documentType` | Number ledger and series report |
| `GET /metrics` | Durations, failures, retries, sizes, queue latency |

Public (no session): `GET /api/documents-automation/deliver/{token}` (`?meta=1`, `?download=1`), `GET|POST /api/documents-automation/verify`, and the Data Room recipient endpoints `/api/document-room/documents[/{objectId}]` (cookie from the existing `/api/data-room-access/{token}` exchange). Cron: `GET /api/cron/document-automation` (`CRON_SECRET`).

Errors are `{error, status}` with a stable meaning: `400` validation, `403` permission or segregation of duties, `404` not found *or not yours* (ids cannot be probed), `409` state conflict (stale, superseded, already decided, in progress), `410` link expired/revoked/superseded/void, `422` generation blocked by a validation error (the body carries the full validation report), `429` rate limit, `502` storage failure (the document is kept as `STORAGE_FAILED` and retried).

## Idempotency

Send `idempotencyKey` (8–100 chars) per user action; the same key always returns the same document. Without a key, the engine derives one from the series, source-data hash, calculation hash, template hash, locale and page size, so an identical repeat is a no-op; a new version needs changed data or `forceNewVersion:true`. The claim row is inserted first under unique indexes on `(orgId, idempotencyKey)` and `(orgId, seriesKey, documentVersion)`.

## Template language

A template is JSON with `schema: "inaya.doc-template/1"`, a `documentType`, optional `locale`, `page` (`size` A4/LETTER, `orientation`, `margins` 20–120pt), `style` (`accentColor`, `fontScale`, `showLogo`), `numbering`, `footer` and a list of **blocks**:

- `header` — title label, org block, right-hand `fields`
- `parties` — 1–3 columns of lines
- `meta` — label/value grid (1–3 columns)
- `table` — `source` (`lines`, `deliveryLines`, `statementRows`, `kpiRows`, `bulletRows`), `columns` (`key`, `labelKey`, `format`, `width`, `align`), `repeatHeader`
- `totals` — rows `{labelKey, path, format, negate, emphasize, when}`
- `text`, `approval`, `signature`, `spacer`, `divider`

Strings may contain `{{namespace.field}}` or `{{namespace.field|format}}` (`text date datetime number integer currency percent`); fields come from a fixed whitelist (`doc org party calc approval flags verify`). An array field on a line by itself expands to one line per element. **Conditions**: `{path, op, value}` with `exists notExists truthy falsy eq neq gt gte lt lte in`, combined with `all`/`any`/`not` (max depth 3). Examples: tax exists `{"path":"calc.totalTax","op":"gt","value":0}`; discount exists `{"path":"calc.invoiceDiscount","op":"gt","value":0}`; shipping address differs `{"path":"flags.shippingAddressDiffers","op":"truthy"}`; payment terms exist `{"path":"doc.paymentTerms","op":"exists"}`; approval required `{"path":"approval.required","op":"truthy"}`; currency differs from default `{"path":"flags.currencyDiffersFromDefault","op":"truthy"}`.

Safety: the validator rebuilds the spec from allowlisted keys and rejects unknown keys, unknown blocks/paths/labels/formats, `__proto__`/`constructor` segments, control characters, strings over 600 characters, more than 60 blocks, specs over 64 KB and over-deep conditions. Values substituted into a template are never re-scanned, so `{{...}}` inside source data is printed literally. Templates cannot run code, fetch URLs, query the database or read files; the only image is the organization logo.

Workflow: clone a system template → edit the draft (server validates every save) → preview against a real record → publish (atomic; immutable afterwards) → set as the default for a type in Settings. Changes are new versions. Archived versions cannot generate new documents but historical documents keep a full copy of the spec they used.

## Adding a document type

1. Add an adapter in `adapters.js` that authorizes and reads source data (return `snapshot`, `calcInput` or `calcCustom`, `view`, `departmentId`, `sourceRecords`).
2. Add a template to `systemTemplates.js` and its labels to `i18n.js` if new.
3. Add a registry entry to `documentTypes.js` (gates, options, source kind) and a prefix to `settings.js`.
4. Add type-specific checks to `validators.js`.
That is all: numbering, storage, evidence, approval, delivery, verification, passport, search and the UI come for free.

## Testing

`test/document-automation-*.test.mjs` run against real MongoDB. `-unit` (calculations, templates, renderer, numbering, settings), `-types` (all nine types, template versioning), `-lifecycle` (idempotency, failure states, retries, search/brief/activity, AI), `-security` (isolation, IDOR, links, injection, tampering) use in-memory pinning providers for speed; `-e2e` is the $25,000 acceptance scenario through the real providers. Run with `RESEND_API_KEY= GEMINI_API_KEY= node --env-file=.env.local --test test/document-automation-e2e.test.mjs`.
