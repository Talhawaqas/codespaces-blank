# Document Automation — Operational Runbook

For operators of an Inaya deployment. Code: `src/lib/documentAutomation/`. Endpoints: `/api/orgs/documents-automation/*`.

## 1. What runs, and where

| Concern | Where | Notes |
|---|---|---|
| Rendering | inside the API request (pdfkit, in memory) | No temp files, no external converter. Bounded: 200 pages, 20 s. |
| Storage | `s3-compat/store.js` → encrypt → shard → pin | Per-org bucket `generated-documents-<orgId>`, Versioning + Object Lock enabled at first use. Falls back across configured pinning providers (Pinata first). |
| Background work | `GET /api/cron/document-automation` (Vercel cron, hourly, `CRON_SECRET`) | Retries failed storage/evidence, expires stale approvals and lapsed quotations, syncs invoice PAID/CANCELLED, sends link-expiry notices. Safe to run concurrently or repeatedly. |
| Fonts | `src/lib/documentAutomation/fonts/` (Noto Sans + Noto Sans Arabic, OFL) | Traced into serverless functions via `outputFileTracingIncludes` in `next.config.js`. If missing, the renderer falls back to Helvetica (Latin only) and reports `unicodeFonts:false`. |

Environment: `MONGODB_URI` (required); at least one of Pinata (`PINATA_JWT` or key/secret) or Filebase (`FILEBASE_ACCESS_KEY/SECRET_KEY/BUCKET`) for storage; `CRON_SECRET`; optional `RESEND_API_KEY`/`EMAIL_FROM` (email notification only — with no key, deliveries record `emailState: NOT_CONFIGURED` and the sender shares the link manually); optional `GEMINI_API_KEY` (advisory summaries only); `NEXT_PUBLIC_APP_URL` (used for the verification URL printed in documents; defaults to `https://inayanetwork.com`).

## 2. Reading document state

Two independent fields on each `generatedDocuments` row:

- `status` — the business lifecycle: `DRAFT GENERATED PENDING_APPROVAL APPROVED FINALIZED DELIVERED VIEWED PAID REJECTED VOID CANCELLED EXPIRED SUPERSEDED`.
- `pipelineState` — the operational state: `GENERATING GENERATION_FAILED STORAGE_FAILED EVIDENCE_PENDING FINALIZING DELIVERY_FAILED COMPLETE`, with `failureStage` and `failureReason`.

A document is complete only when `pipelineState = COMPLETE`. The Document Automation → Health tab, the Brief, the Activity Center and trust-health all count non-complete documents.

## 3. Playbooks

**A document shows STORAGE_FAILED.** Almost always a pinning-provider problem (an exhausted plan shows as `HTTP 403 ... plan usage limit`; an outage as network errors). The engine already tried every configured provider. Fix the provider (upgrade the plan, restore credentials). Recovery is automatic on the next hourly cron (`documentJobs` back off 1, 2, 4… min up to 5 attempts), or press **Retry now**, or `POST …/documents/{id}/retry`. A retry re-renders from the stored snapshot with the same number and records whether the bytes were reproduced (`REPRODUCTION_NOTE`). After 5 failures the job is `GAVE_UP`, the owner is notified, and an operator should fix the cause and retry manually.

**EVIDENCE_PENDING.** The PDF is stored but the evidence chain/graph link did not finish. It is retried by cron or manually; nothing else is needed. If it persists, check MongoDB health and the org's audit chain (`verifyChainIntegrity`).

**GENERATION_FAILED.** The renderer failed (for example a document over 200 pages). Read `failureReason`. Reduce the document or cancel it (the number is recorded as `CANCELLED`).

**FINALIZATION_FAILED evidence node / `STORAGE_FAILED` at finalize.** The stored draft no longer hashes to its recorded fingerprint, or the final store failed. The document stays `APPROVED`/`GENERATED` and is *not* finalized. Investigate storage integrity before retrying; an `INTEGRITY_FAILURE` node records expected vs actual hashes.

**A recipient reports a dead link.** The access log (Delivery tab → *Recipient access log*) records every attempt including denials with a reason: `EXPIRED`, `REVOKED`, `LIMIT`, `SUPERSEDED`, `VOID`, `CANCELLED`, `EXPIRED` (document), `VERSION_MISMATCH`, `INTEGRITY`. A superseded or voided document's links are revoked automatically by design; create a new delivery from the current version.

**Number gaps.** Open Settings → *Number ledger*. Every sequence value is accounted for; cancelled, voided and failed numbers show their reason. `unaccountedSequences` should always be empty — if it is not, treat it as an incident (a counter advanced without a ledger row).

**Verifying integrity for an auditor.** Document → *Verify stored copy* (full recomputation incl. decrypting the stored object) and *Passport (PDF)*. Externally: `/verify-document`. To verify the whole org: `GET /api/orgs/evidence-export` includes a `documentAutomationEvidence` section.

## 4. Retention, deletion and immutability

Finalized objects get an Object Lock retention period (Settings → Retention, default 2,555 days ≈ 7 years, `GOVERNANCE`). While it runs, the storage layer refuses delete/overwrite. Superseded versions are kept. There is deliberately no hard-delete path for a finalized document — void it (reason required; its number stays `VOIDED`, links are revoked).

## 5. Security operations

- Every endpoint authenticates, scopes to the org from the caller's membership, checks permission, rate-limits per user (public endpoints per IP) and audits. Rate-limit state is `rate_limit_hits` (24 h TTL).
- Secure links are 256-bit tokens; only the hash is stored. Revoke from the Delivery tab; supersede/void/cancel/expire revoke automatically.
- Data Room deliveries verify the recipient's email by magic link (30-minute link, session for the chosen expiry) and can require confidentiality terms.
- Metrics (`documentMetrics`, 90-day TTL) hold numbers and short enumerated labels only — never document text, keys or personal data. Never log plaintext documents.
- The evidence chain can be re-verified at any time; a broken node or audit-chain entry makes `verify` report `verified:false` and the trust-health snapshot go to attention.

## 6. Capacity and limits

Up to 2,000 line items per document, 500 caller-supplied option lines, 64 KB of options, 200 pages, 20 s render time, 15 MB uploaded PDFs, 60 blocks / 64 KB per template, 500 evidence nodes per document. Storage cost is one encrypted object per stage (draft, and a second final object only when approval was required). Rendering runs in the API function (`maxDuration` 60–120 s); very large batch generation should be spread out or moved to a queue.

## 7. Deployment checklist

1. `npm run build` clean; the Noto fonts are in the build output trace.
2. `vercel.json` contains the `/api/cron/document-automation` hourly entry and `CRON_SECRET` is set.
3. At least one pinning provider is configured with headroom (plan limits!).
4. Smoke test on the live domain: generate → finalize → link → open → verify (see the completion report).
5. Confirm `RESEND_API_KEY` if email notifications are wanted; otherwise senders copy links manually.

## 8. Known operational limits

Storage availability bounds generation: with every pinning provider down, generation fails honestly (`STORAGE_FAILED`) and recovers later. Byte-identical re-rendering holds on the same Node/ICU runtime; the runtime is recorded in each manifest. Fonts cover Latin/Greek/Cyrillic/Arabic-script; other scripts are flagged, not silently dropped.
