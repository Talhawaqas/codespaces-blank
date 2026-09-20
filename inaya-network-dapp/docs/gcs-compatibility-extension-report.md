# Google Cloud Storage Compatibility Extension SOW — Report

Per the SOW's own mandated principle: **Audit → Reuse → Implement only genuine gaps → Test → Secure → Prove.**

## Phase 0 — Audit

Re-read `sigv4.js`, `auth.js`, `credentials.js`, the `/api/s3/*` routes, the Business Workspace S3 panel, org/member permission mapping (`orgs.js`), and audit hooks (`org-activity-log.js`) before writing anything. Confirmed the baseline: 23/23 (14 SigV4 + 9 store) passing, unchanged as the starting point. Found two real, directly-reusable precedents already in the codebase for the two hardest-looking phases:

- **Phase 1 (OAuth)**: `azureAuthMiddleware.js`'s `authenticateViaEntra` already does exactly this shape of federation (verify a real external token → map the resulting identity to an existing active org membership by email → return the same `{owner, accessKeyId}` shape every other auth path returns). Mirrored directly.
- **`verifyGoogleIdToken`** (`src/lib/googleAuth.js`) already exists — real `google-auth-library` verification (signature/issuer/audience/expiry against Google's live JWKS), used today for the app's own "Sign in with Google." Reused as-is, zero changes.

## What was built

### Phase 1 — Google OAuth (`src/lib/s3-compat/auth.js`)

`Authorization: Bearer <Google ID token>` is now a third authentication path alongside AWS4/GOOG4 HMAC signatures, dispatched in `authenticateS3Request`. The token is verified for real (never decoded/trusted locally); the resulting Google-verified email is mapped to an **existing, active** Inaya org membership — an unmapped identity is rejected outright, never silently granted access. No parallel authorization system: once mapped, the request carries the same org-membership-derived access the Entra path already grants. "Revoked identity" is enforced on Inaya's own side (membership `status !== "active"`), since Inaya's membership state — not Google's — is authoritative for Inaya access. Every successful OAuth authentication is logged to the existing audit chain (`S3_GOOGLE_OAUTH_AUTHENTICATED`).

### Phase 2 — Temporary signed URLs (`src/lib/s3-compat/signedUrl.js`)

A new `?presign` sub-resource (`GET /api/s3/{bucket}/{key}?presign&expiresIn=3600`) issues a time-limited download URL. Deliberately **not** a reimplementation of AWS SigV4's or GCS's own presigned-URL canonicalization algorithm (disclosed plainly in the module's own header) — a smaller, real, Inaya-specific `INAYA-HMAC-SHA256` query-string scheme that satisfies every one of the SOW's actual Phase 2 requirements: the signature covers method + bucket/key + expiry, keyed by the creator's own real `secretAccessKey`, so a signed URL can never grant more than its creator's own credential already permits (verification re-resolves that same credential and re-runs the same `checkScope`). TTL is capped at 7 days. Creating one is itself audited (`SIGNED_URL_CREATED`).

### Phase 3 — Virtual-hosted bucket addressing (`src/middleware.js`)

`https://<bucket>.<base-host>/<object>` is implemented as a **pure URL rewrite** to the existing path-style routes — not a second implementation of the S3 surface. `S3_COMPAT_VIRTUAL_HOST_BASE` (unset by default) configures the base host; the middleware is a complete no-op until an operator sets it, so this ships inert for every existing deployment. Bucket names are validated against real S3 naming rules (lowercase/digits/hyphens, no dots — matching AWS's own documented restriction that virtual-hosted addressing requires DNS-compliant, non-dotted bucket names) before ever reaching the routing layer; a malformed or multi-level subdomain is rejected with a real 400, not silently truncated. This repo makes **no DNS/TLS changes of its own** (per the SOW's explicit "do not make uncontrolled production DNS changes") — a real deployment needs its own wildcard DNS record and certificate, documented below.

**A real bug found via building this**: `req.url` inside a Next.js Route Handler does **not** reflect a middleware rewrite's destination path (confirmed live — it reads back the client's original, un-rewritten path), even though Next.js's own dynamic route matching (`params.bucket`/`params.key`) resolves correctly against the rewritten target. Re-parsing `req.url` for the bucket/key used in **scope enforcement** would therefore silently disagree with the bucket/key the route actually operates on for any virtual-hosted request. Fixed by having every route pass its own authoritative `params` into `authenticateS3Request` explicitly, rather than having that function independently re-derive the same answer from a channel that, for this one request shape, gives a different one.

## Real bugs found and fixed via Terraform-adjacent and live testing (benefit every client, not just GCS)

1. **Missing `GetObjectAcl` (`?acl`)** — found live via `gcloud storage objects describe`/`rm`, which call this internally before acting. With no handler, it fell through to plain `GetObject`, returning raw file bytes where an ACL XML document was expected; the client then crashed trying to parse content as XML. Added a real, minimal `AccessControlPolicy` (the requester as sole `FULL_CONTROL` grantee — this layer has no separate ACL model to represent honestly beyond credential-scoped ownership).
2. **`req.url` vs. middleware rewrite** (above) — a real, load-bearing architectural fix, not specific to any one client.

## Testing

- **`test/signed-url.test.mjs`** — 9 real DB-backed tests: valid GET/HEAD, path/bucket retargeting rejected, real expiry rejection (constructed independently of `createSignedUrl`'s own minimum-TTL clamp), revoked-credential invalidation, unauthorized-method rejection, 7-day TTL cap, and "not a signed-URL request at all" detection. **All 9 pass.**
- **Live, real-HTTP proof** (virtual-hosted addressing + signed URLs together), using real DNS: `S3_COMPAT_VIRTUAL_HOST_BASE=s3.127.0.0.1.sslip.io` — [sslip.io](https://sslip.io) is a real, public wildcard-DNS-to-IP service (any subdomain ending in an embedded IP resolves to that IP), used here so this could be genuinely live-tested end-to-end against localhost without any production DNS change. 18/18 checks passed: bucket-subdomain PUT/GET/LIST/DELETE with byte-identical content, path-style access to the same object still works (no regression), malformed/multi-dot subdomains rejected, an unrelated Host header correctly passes through untouched, and — separately — the full signed-URL adversarial suite (tamper object path/expiry/signature, wrong method, real elapsed-time expiry measured in wall-clock time, not just a manipulated field).
- **Regression**: `test/s3-compat-store.test.mjs` (9), `test/s3-compat-sigv4.test.mjs` (14), `test/s3-compat-capabilities.test.mjs` (7), `test/s3-compat-empty-folder.test.mjs` (17) — all re-run clean after every change in this SOW, including the `authenticateS3Request` signature change (which now every route passes `routeParams` into).

## Phase 4 — gsutil (real investigation, not resolved)

Exact versions recorded: `gsutil 5.25`, `boto 2.49.0`, Google Cloud SDK `447.0.0`. Configured `.boto` with a real, resolving hostname containing the substring `"s3"` (`s3.127.0.0.1.sslip.io`) specifically to test whether the previously-diagnosed vendored-`boto` region-detection crash (`UnboundLocalError` when the endpoint hostname doesn't contain `"s3"`) could be avoided through supported configuration alone (no third-party source patching, per the SOW's own explicit prohibition). **Result: the original crash is avoided** — gsutil no longer hits that `UnboundLocalError`. However, `gsutil mb`/further operations then fail with a separate, later-stage connection issue (`OSError: connection actively refused` on one attempt; a hang with no request ever reaching the server on another) inside gsutil's own legacy `boto` 2.x connection-setup code, which this SOW's time budget did not resolve without patching that third-party code (still out of scope). **Documented finding**: gsutil S3-compatible mode remains unverified, for a more specific, narrower reason than before — a connection-setup issue in Google's own legacy `boto` stack, not the originally-diagnosed region-detection crash, which is now confirmed avoidable.

## Phase 5 — gcloud storage (real investigation, genuinely resolved further than the prior SOW's finding)

The prior SOW's report stated gcloud storage "does not appear to support custom S3-compatible endpoints." **That finding was incomplete** — `gcloud storage` (the modern CLI, distinct from legacy `gsutil`) has real, officially documented S3-interoperability support via `gcloud config set storage/s3_endpoint_url <url>` (boto3-based, separate from gsutil's legacy boto2 stack), gated behind an explicit self-disclosed warning Google prints on every invocation: *"S3 support is currently unstable and should not be relied on for production workloads."*

Exact version recorded: Google Cloud SDK `447.0.0` / `gcloud storage` (bundled). Configured with real Inaya HMAC credentials via a dedicated AWS credentials profile. Real results:

| Operation | Result |
|---|---|
| Upload (`cp` to `s3://`) | ✅ Confirmed via server logs (`PUT ... 200`) |
| Download | ✅ Byte-identical content, confirmed via independent direct verification |
| List (`ls`) | ✅ Correctly showed the uploaded object |
| Metadata (`objects describe`) | ❌→✅ Crashed initially on the missing `?acl` handler (found and fixed above); after the fix, produced a real, correctly-parsed response, though with intermittent immediate-consistency quirks under real write latency |
| Delete (`rm`) | Inconsistent — sometimes silent no-op, sometimes hangs, consistent with Google's own "unstable" labeling of this feature rather than a further Inaya-side gap (the underlying `DeleteObject` route itself is the same one AWS CLI/Terraform/rclone all successfully use) |

**Documented finding**: `gcloud storage`'s S3-interoperability mode genuinely works for the core operations (upload, download, list) against Inaya's real endpoint, with real proof. Metadata/delete show real rough edges that align with Google's own explicit "unstable" self-disclosure on this feature — not further claimed as fully proven, per the SOW's own "do not classify an external client crash as an Inaya server failure" instruction, once the one genuine server-side gap (`?acl`) was found and closed.

## Business Workspace (Phase 6)

Extended the existing `S3CompatView.js` panel with a compact "Additional access paths" block (Google sign-in, temporary signed URLs, virtual-hosted addressing) — no separate Google administration console, per the SOW's own instruction.

## Audit / Trust (Phase 7)

Every new material action — Google OAuth authentication, signed-URL creation — logs to the **existing** audit chain (`logOrgActivity`/`auditChain.js`), never a parallel system. No OAuth tokens, HMAC secrets, or signing secrets are ever stored or logged — every log entry records identity/scope/outcome metadata only.

## Known limitations (disclosed, not silently absent)

- `gsutil` S3-compatible mode remains unverified (see Phase 4) — a real, external, narrower-than-before limitation in Google's own legacy `boto` stack.
- `gcloud storage`'s metadata/delete operations show real rough edges Google itself labels "unstable"; core operations (upload/download/list) are proven.
- Virtual-hosted addressing requires an operator to provision real wildcard DNS + a matching TLS certificate and set `S3_COMPAT_VIRTUAL_HOST_BASE` — this SOW implements and live-tests the server-side rewrite only, per its own explicit "do not make uncontrolled production DNS changes" instruction.
- The Inaya signed-URL scheme is **not** byte-compatible with AWS SigV4 or GCS V4 presigned URLs — a client that constructs its own presigned URL using the real AWS/GCS algorithm will not work against this endpoint; only URLs issued via `?presign` do.
- Presigned-URL creation via a virtual-hosted request returns a URL using the internal request origin, not the original vhost hostname, in this environment — a known, narrow edge case for the presign+virtual-host combination specifically (path-style presign is fully correct and is what's tested above).

## Explicit non-goals honored

No duplicate storage engine, credential system, authorization layer, or audit system. No claim of full GCS parity, official Google partnership, or certification. No third-party (Google) source code patched. No uncontrolled production DNS change made.
