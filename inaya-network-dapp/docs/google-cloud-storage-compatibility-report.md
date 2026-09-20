# Google Cloud Storage Compatibility Layer SOW — Report

Per the SOW's own mandated principle: **Audit → Reuse → Implement only genuine gaps → Test → Secure → Integrate → Prove**. This report cites real files and real test results throughout.

## Phase 0 — Gap Audit (mandatory, done first)

Reviewed every file the SOW named (`crypto.js`, `credentials.js`, `sigv4.js`, `auth.js`, `store.js`, `walletStore.js`, `xml.js`, the `/api/s3/*` routes, both credential-route pairs, `S3CompatView.js`, existing tests) against Google's own documented XML API requirements.

**The finding that shapes this entire SOW:** Google deliberately designed Cloud Storage's XML API (`storage.googleapis.com`, the endpoint this SOW itself scopes to in §4.1) to be S3-interoperable — its object CRUD, listing, XML response schemas, and multipart-upload mechanics are the *same* S3-shaped surface already built and shipped in the Multi-Cloud Storage Compatibility SOW. Concretely:

| Capability | Audit result | Action |
|---|---|---|
| Object CRUD, listing, HEAD, DELETE, byte-range GET | **Already works, unchanged** | Reuse — GCS's XML API uses the same operations |
| XML response shapes (`ListBucketResult`, `ListAllMyBucketsResult`, etc.) | **Already compatible, unchanged** | Reuse — GCS's XML API deliberately mirrors S3's schema |
| Multipart / large-object uploads via the XML API | **Already works, unchanged** | Reuse — the XML API's own multipart mechanism (Initiate/UploadPart/Complete) *is* S3-multipart-shaped by Google's own design. GCS's genuinely different resumable-upload protocol (session-URI + `Content-Range` chunked PUTs) belongs to the **JSON** API, which is outside this SOW's own §4.1 endpoint scope |
| Credential issuance, scoping, revocation, audit | **Already fully reusable, unchanged** | `credentials.js` is protocol-agnostic by design — no Google-specific credential type needed |
| `AWS4-HMAC-SHA256` signing | **Already works, unchanged** | This is GCS's own documented "S3 interoperability" signing mode — byte-identical to real AWS SigV4. Any client using it (AWS CLI/SDK, boto/gsutil configured for a non-Google S3-compatible endpoint, Google client libraries in AWS-compat mode) already worked before this SOW started |
| **`GOOG4-HMAC-SHA256` native signing** | **Genuine gap** | `sigv4.js` hardcoded the `AWS4-HMAC-SHA256`/`aws4_request`/`x-amz-*` constants — a client producing a native Google signature was rejected outright. **Implemented this pass** (see below) |
| OAuth 2.0 / service-account identity mapping | Conditional, no validated workload named | **Scoped out**, documented as a future extension |
| V4 signed URLs | Conditional, no validated workload named | **Scoped out**, documented as a future extension |
| Virtual-hosted-style addressing (`BUCKET.storage.googleapis.com`) | Conditional ("where required by tested clients") | **Scoped out** — would require wildcard DNS + subdomain-based routing, an infrastructure/deployment decision beyond this codebase; path-style addressing (already fully supported) remains Google's own continued-support option too |

**Do not fork the SigV4 engine** (§5.2's own instruction) was honored literally: the one genuine gap was closed by generalizing the existing engine, not duplicating it.

---

## Implementation — the one genuine gap, closed

`src/lib/s3-compat/sigv4.js` now detects the signing scheme from the Authorization header's own algorithm prefix and dispatches through one shared, parameterized implementation:

```js
const SCHEMES = {
  "AWS4-HMAC-SHA256":  { requestType: "aws4_request",  keySeed: "AWS4",  dateHeader: "x-amz-date",  contentSha256Header: "x-amz-content-sha256" },
  "GOOG4-HMAC-SHA256": { requestType: "goog4_request", keySeed: "GOOG4", dateHeader: "x-goog-date", contentSha256Header: "x-goog-content-sha256" },
};
```

Both schemes are the *same* HMAC-chain algorithm (canonical request → string-to-sign → derived signing key → HMAC) — only the constant strings and header names differ, exactly as Google's own documentation describes GOOG4 as a drop-in analog to AWS SigV4. `parseAuthorizationHeader`, `deriveSigningKey`, and `verifySigV4Request` all now read these constants from the detected scheme rather than hardcoding AWS's. **`src/lib/s3-compat/auth.js` required zero changes** — its credential-extraction regex was already algorithm-agnostic, and it calls `verifySigV4Request` exactly as before.

No new API routes were added. GOOG4-signed requests hit the exact same `/api/s3/[bucket]/[...key]` routes AWS4 requests already use, since GCS's XML API uses the same path-style addressing.

---

## Testing

### Unit tests (`test/s3-compat-sigv4.test.mjs`) — 14/14 passing

The original 9 AWS4 tests pass unchanged (confirming the generalization introduced no behavioral change to the already-proven path), plus 5 new GOOG4-specific tests:

- Accepts a correctly-signed GOOG4-HMAC-SHA256 request
- Rejects a GOOG4 request signed with the wrong secret
- Rejects a tampered GOOG4 request (body changed after signing)
- **Rejects an AWS4 signature replayed with GOOG4's algorithm label** (SECURITY) — proves the two schemes' key derivation is genuinely different, not the same signature silently accepted under either label
- `parseAuthorizationHeader` correctly identifies and routes each scheme to its own constants

### Live, real-HTTP proof against the running dev server

A from-scratch Node client implementing Google's real, published GOOG4-HMAC-SHA256 algorithm — independent of the server code, the same "manually re-implement the client side" technique already used to verify Azure Shared Key and AWS SigV4 in earlier SOWs — was run against a real, freshly-issued credential and the real running server:

| Operation | Result |
|---|---|
| Create bucket | ✅ `200` |
| Upload object | ✅ `200` |
| HEAD object | ✅ `200`, correct `Content-Length` |
| Download object | ✅ **byte-identical** to what was uploaded |
| List objects | ✅ uploaded key present |
| **Wrong secret (SECURITY)** | ✅ rejected `403 SignatureDoesNotMatch` |
| Delete object | ✅ `204` |
| Delete bucket | ✅ `204` |

All 11 checks passed. Confirmed in the dev server's own request log (`DELETE /api/s3/goog4-live-test-bucket 204`) that these were genuine HTTP round-trips, not mocked.

### Real Google Cloud tooling

`gcloud`/`gsutil` (Google Cloud SDK 447.0.0) were made to actually run in this environment (this sandbox had no working Python runtime by default; a real Python 3.12 was installed, and the SDK's own bundled interpreter — `platform/bundledpython/python.exe` — was used to run `gcloud`/`gsutil` themselves once `CLOUDSDK_PYTHON` was pointed at it).

**A real, external bug was found in Google's own vendored `boto` library** (`gslib/vendored/boto/boto/auth.py`, `S3HmacAuthV4Handler.determine_region_name()`): when boto's `s3://` S3-compatibility mode is pointed at a hostname containing no substring `"s3"` (e.g. `localhost:3000`, or any custom endpoint), its region-detection loop never assigns `region_name` on any branch, and the Python method raises `UnboundLocalError` — a genuine, pre-existing bug in Google's own shipped tooling, unrelated to anything in this codebase, confirmed by reading the traceback back to that exact line. Not something a wildcard-DNS or config workaround can fix without editing the SDK's own installed files, which is outside the scope of what this codebase can or should patch. **Disclosed, not silently worked around**: `gsutil`'s S3-compatible mode is stated here as **untested due to this external client-side bug**, not claimed working.

This doesn't weaken the actual compatibility claim: `gsutil`'s S3-compatible mode uses the exact same `AWS4-HMAC-SHA256` signing this codebase already proved end-to-end against the real AWS CLI in the Multi-Cloud Storage Compatibility SOW — the algorithm itself is not in question, only this one specific client's unrelated hostname-parsing bug. `gcloud storage` (the modern CLI replacing `gsutil`) does not appear to support pointing at a third-party S3-compatible endpoint at all — not tested for the same reason.

### Regression testing

`test/s3-compat-sigv4.test.mjs` (14, including the 9 original) and `test/s3-compat-store.test.mjs` (9) — all passing, zero regressions from generalizing the signing engine.

---

## Business Workspace integration (§9)

Per the SOW's own instruction not to build a second administration console: no new UI section was added. `S3CompatView.js`'s existing endpoint/credential panel now states plainly that the same endpoint and credential accept Google Cloud Storage's XML API signing conventions (both interoperability modes) — one credential, no separate Google-specific setup, matching how the same credential already doubled for S3 and Azure.

---

## Security (§15)

- No new credential type, no new secret-storage mechanism — the existing envelope-encrypted, revocable, audit-logged credential system is unchanged.
- The cross-scheme confusion test above is a genuine adversarial case, not just a happy-path check: it proves a request cannot be authenticated by mixing one scheme's real signature with another scheme's algorithm label.
- Every other Inaya security property (organization isolation, fail-closed authorization, audit logging, no bypass around compatibility encryption) is inherited unchanged, since GOOG4-signed requests flow through the exact same `authenticateS3Request` → `store.js`/`walletStore.js` path every other request already does.

---

## Explicit non-goals honored

Per §18: no Google Cloud competitor was built, no new object-storage engine, no replacement of Inaya's native encryption/sharding/redundancy/backup, no rebuild of the S3 compatibility layer, no Google Cloud Marketplace product, no claimed official Google partnership, no second administration console. Public positioning language should use the SOW's own suggested wording (§17) — compatibility, not partnership or certification.

## Known limitations (disclosed, not silently absent)

**Update — all five items below were addressed by the follow-on GCS Compatibility Extension SOW; see [gcs-compatibility-extension-report.md](gcs-compatibility-extension-report.md) for what changed and its own, still-current limitations.**

- ~~OAuth 2.0 / service-account identity mapping — not implemented~~ → implemented (Google ID token Bearer auth).
- ~~V4 signed URLs — not implemented~~ → implemented (Inaya-specific signed-URL scheme, disclosed as not byte-compatible with AWS/GCS's own presigned-URL algorithms).
- ~~Virtual-hosted-style addressing — not implemented~~ → implemented (optional, off by default; requires an operator-configured wildcard host).
- `gsutil` S3-compatible mode — **still unresolved**; the extension SOW found the originally-diagnosed region-detection crash is avoidable, but a separate connection-level issue remains in gsutil's own legacy `boto` 2.x stack.
- `gcloud storage` — **corrected finding**: it *does* support custom S3-compatible endpoints (`gcloud config set storage/s3_endpoint_url`), officially documented though labeled "unstable" by Google's own CLI. Real upload/download/list verified working; see the extension report for the one narrow gap found and fixed (`GetObjectAcl`) and remaining client-side rough edges.
- Presigned/signed-URL query-string signing — see the "V4 signed URLs" line above.
