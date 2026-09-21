# AWS S3-Inspired Storage Feature Expansion

**Status:** Implemented and tested (Tier 1 scope). **Date:** September 2026.

## Phase 0 Audit — What Already Existed vs. Genuine Gaps

| AWS capability | Status before this SOW | Treatment |
|---|---|---|
| Object tags / rich metadata | Genuinely missing — no field existed | Built |
| Storage Inventory | Genuinely missing — no cross-bucket export existed | Built |
| Batch Operations | Genuinely missing | Built, as a thin orchestration loop over existing primitives |
| Checksum compatibility | Partial — ETag existed but was salted for dedup, not independently verifiable | Added a genuine, additive `contentSha256` field |
| Object Lock / Legal Hold / Versioning / Lifecycle | Already fully built and enforced | Untouched, reused as-is |
| Credential scoping (bucket/prefix/operation/expiry) | Already fully built | Untouched; the policy analyzer reads it, never modifies it |
| Storage Analytics | Partial — only an org-wide total existed | Added real per-bucket breakdown |
| Storage Access Policy Analyzer | Genuinely missing | Built, strictly read-only |
| Block Public Access | Not applicable | Confirmed no unauthenticated read path exists anywhere in the S3-compat auth layer — nothing to block |
| Event notifications/webhooks | Genuinely missing, and the largest lift (zero reusable outbound-webhook infrastructure anywhere in the codebase) | **Deferred** |
| MFA/step-up for destructive actions | Genuinely missing, but Object Lock/Legal Hold already provide real destructive-action protection for the highest-risk case (permanent deletion) | **Deferred** — not duplicating protection that already exists, per the SOW's own §11 instruction |

## What Was Built

- **Object Tags** (`store.js`/`walletStore.js`: `putObjectTagging`/`getObjectTagging`/`deleteObjectTagging`) — real S3 tag semantics (max 10 tags, 128/256-char key/value limits), wired into the object route's `?tagging` sub-resource and the `x-amz-tagging` header on initial PUT. Audited through the existing activity/audit chain.
- **Checksum** — a new `contentSha256` field: the real, unsalted SHA-256 of the uploaded bytes, distinct from the existing `fileHash` (which is deliberately salted with the document's own `_id` for an unrelated legacy dedup reason and therefore can't serve as a client-verifiable checksum). Exposed as `x-amz-checksum-sha256` on GET/HEAD/PUT responses.
- **Storage Inventory** (`inventory.js`) — a real, org-scoped export (JSON/CSV) of every live object across one or all buckets, including tags, checksum, and lock state.
- **Batch Operations** (`batchOperations.js`) — bulk tag/retention/legal-hold application over up to 1000 keys per request, built strictly as a loop over the existing per-object primitives (no new low-level mutation path, per the SOW's explicit architecture requirement). A locked object fails its own key in the per-key result; it never crashes the job or bypasses the lock.
- **Storage Analytics** (`analytics.js`) — real per-bucket object count, total/average size, largest objects, version count, locked/legal-hold counts, and tag distribution.
- **Storage Access Policy Analyzer** (`policyAnalyzer.js`) — read-only, flags unrestricted/no-expiry/broad-destructive-scope credentials from real stored fields. "Unused credential" detection is explicitly reported as `null` (not computed), since `s3_credentials` has no `lastUsedAt` field — an honest gap, not a fabricated signal.
- All five new capabilities are exposed through the existing session-authenticated `/api/orgs/s3-compat/manage` route (new `tags`/`inventory`/`analytics`/`policy-analysis`/`batch` actions), matching this route's established `action=` dispatch convention rather than creating five new route files.

## A Real Bug Found and Fixed Along the Way

During live verification, `pinningProviders/pinata.js` was found to only implement Pinata's JWT auth (`PINATA_JWT`), while this environment's actual credential was stored as `PINATA_API_KEY` (a short key id) / `PINATA_SECRET_API_KEY` (which, despite its name, holds a full Pinata scoped-key JWT) — meaning Pinata was silently never usable, and `primaryProviderName()` was falling back to Filebase as the de facto primary shard-storage provider in this dev environment (not just its intended backup-replication role). `pinata.js` now detects a JWT by shape across all three candidate variables rather than a single hardcoded name; the fix was verified live with a real pin/status/fetch/unpin round trip through Pinata before deployment. This is a genuine, pre-existing bug independent of this SOW's own scope, fixed because it directly blocked test execution.

## Testing

New suite: `test/s3-compat-expansion.test.mjs`, 9 tests, all passing against the real database and real pinning provider — including the checksum computation, tag validation limits, a mixed-success batch job, the explicit security test that a batch operation cannot bypass Object Lock/Legal Hold, org-scoped inventory isolation, per-bucket analytics correctness, and confirmation that the policy analyzer never writes to `s3_credentials`.

Existing regression suites — `s3-compat-store` (9+), `s3-compat-capabilities` (19), `s3-compat-empty-folder` (15), `s3-compat-sigv4` (14) — all passing, zero regressions from the `store.js`/`walletStore.js`/object-route changes. Production build (`npm run build`) compiles cleanly.

## Known Limitations / Explicitly Deferred

- **Event notifications/webhooks** — not built. Per the Phase 0 audit, this codebase has zero outbound-webhook infrastructure (only inbound receivers for Stripe/referrals/KYC exist) — building real signed delivery, retry, and dead-letter handling is a substantial, separate-scope undertaking the SOW's own audit flagged as the largest lift among all candidates.
- **MFA/step-up authentication** — not built. Object Lock and Legal Hold already provide real, server-enforced protection against the highest-risk destructive action (permanent deletion) that a step-up mechanism would otherwise exist to protect — the SOW's own §11 explicitly says not to add a parallel system where equivalent protection already exists.
- **Sensitive-data discovery, query-in-place, native vector storage, table storage, SFTP/FTPS gateway, private connectivity, dataset exchange** — all Tier 2/3/4 per the SOW's own prioritization; not attempted in this pass.
- **Management-console UI** for tags/inventory/batch/analytics/policy-analysis — the API surface is complete and tested; a dedicated Business Workspace UI panel for these (vs. the existing S3-compat management view) was not built in this pass.
- **Block Public Access** — confirmed as not applicable rather than deferred: the audit found no code path anywhere in the S3-compat auth layer that permits an unauthenticated read, so there is nothing to build.

No AWS partnership, certification, or full-parity claim is made anywhere in this work.
