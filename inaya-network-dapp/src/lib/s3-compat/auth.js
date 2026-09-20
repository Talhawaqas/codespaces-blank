// src/lib/s3-compat/auth.js
//
// Ties credential resolution (credentials.js) to signature verification
// (sigv4.js) into the one function every S3-compat route calls. Mirrors
// api-keys.js's requireApiKey() shape (returns { orgId, accessKeyId } or
// throws an S3AuthError the route maps to a real S3-shaped error response)
// so auth here reads the same way every other route's auth check does.

import { resolveS3Credential, checkScope } from "./credentials.js";
import { verifySigV4Request } from "./sigv4.js";
import { verifyGoogleIdToken } from "../googleAuth.js";
import { verifySignedUrl } from "./signedUrl.js";
import { getOrgCollections, normalizeEmail } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";

export class S3AuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code; // S3 error <Code> value, e.g. "AccessDenied" | "SignatureDoesNotMatch"
    this.status = status;
  }
}

const OPERATION_BY_METHOD = { GET: "READ", HEAD: "READ", PUT: "WRITE", POST: "WRITE", DELETE: "DELETE" };

/** Derives { bucket, key, operation } from the REQUEST ITSELF (URL path +
 *  HTTP method) -- never from anything a client claims about its own
 *  permissions -- for Granular Storage Access Grants enforcement (SOW §2).
 *  Mirrors exactly how /api/s3/[bucket]/[...key]/route.js's own dynamic
 *  segments parse the same URL, so scope enforcement sees the same
 *  bucket/key every route handler itself will act on. `url.pathname` is
 *  already bucket-first by the time this runs regardless of whether the
 *  request arrived path-style or was rewritten from virtual-hosted
 *  addressing by middleware.js -- this function never looks at Host. */
export function deriveRequestTarget(url) {
  const segments = url.pathname.replace(/^\/api\/s3\/?/, "").split("/").filter(Boolean);
  const bucket = segments[0] || null;
  const key = segments.length > 1 ? segments.slice(1).join("/") : null;
  return { bucket, key };
}

/** GCS Compatibility Extension SOW, Phase 1 -- real Google OAuth identity
 *  federation as an ADDITIONAL authentication path alongside HMAC SigV4,
 *  never a replacement. Structurally identical to the already-proven Entra
 *  ID path in azureAuthMiddleware.js's authenticateViaEntra: a real
 *  external identity token is verified (never decoded/trusted locally --
 *  verifyGoogleIdToken calls the real google-auth-library, which validates
 *  signature, issuer, audience, and expiration against Google's own live
 *  JWKS), then mapped onto an EXISTING Inaya org membership by email. An
 *  unmapped Google identity is rejected outright, not silently granted
 *  access. No parallel authorization system: once mapped, the request
 *  carries the same org-membership-derived access any other federated path
 *  already carries -- there is no separate "Google scope" tier.
 *
 *  "Required scopes" (§3): this is identity-only federation (Inaya never
 *  calls any Google API on the caller's behalf), so the only real
 *  requirement is a Google-verified email, which verifyGoogleIdToken
 *  already enforces (email_verified: true). "Revoked identity" (§3's test
 *  list) is enforced on Inaya's own side, exactly like Entra: a Google
 *  identity that authenticates successfully but whose Inaya membership is
 *  no longer "active" is rejected -- Google can't revoke Inaya's own
 *  membership state, and Inaya's own state is authoritative for access. */
async function authenticateViaGoogleOAuth(idToken) {
  let email;
  try {
    ({ email } = await verifyGoogleIdToken(idToken));
  } catch (err) {
    throw new S3AuthError("AuthenticationFailed", `Google identity token could not be verified: ${err.message}`, 403);
  }

  const { orgMembers } = await getOrgCollections();
  const membership = await orgMembers.findOne({ email: normalizeEmail(email), status: "active" });
  if (!membership) {
    throw new S3AuthError("AuthenticationFailed", `${email} authenticated with Google, but is not an active member of any Inaya organization.`, 403);
  }
  const accessKeyId = `google:${email}`;
  await logOrgActivity({
    orgId: membership.orgId,
    recordType: "s3_google_oauth",
    recordId: membership._id,
    actorEmail: email,
    action: "S3_GOOGLE_OAUTH_AUTHENTICATED",
    previousState: null,
    newState: null,
    metadata: { email },
  });
  return { owner: { type: "org", orgId: membership.orgId.toString() }, accessKeyId };
}

/** `bodyBuffer` must be the raw request body read BEFORE any parsing -- S3
 *  payloads are arbitrary binary. Returns { owner, accessKeyId } where owner
 *  is { type: "org", orgId } or { type: "wallet", walletAddress }. Enforces
 *  the credential's stored scope (if any) server-side, in addition to
 *  signature verification -- a valid signature alone is no longer
 *  sufficient once a credential carries a narrower grant than its owner's
 *  full access.
 *
 *  Three authentication paths, checked in this order, all converging on the
 *  SAME scope enforcement below (GCS Compatibility Extension SOW): a
 *  signed-URL query string (no Authorization header at all -- that's the
 *  point of a shareable link), a Bearer Google OAuth identity token, or the
 *  original header-based AWS4/GOOG4 HMAC signature. Exactly one of these
 *  ever resolves a request; an unrecognized/missing credential is a real
 *  rejection, never a silent fallback between paths.
 *
 *  `routeParams` (`{ bucket, key }`, `key` may be `null` at bucket-only
 *  routes), when passed, OVERRIDES the bucket/key this function would
 *  otherwise re-derive from `req.url`'s own pathname. Real, load-bearing
 *  reason (GCS Compatibility Extension SOW, Phase 3): after a virtual-
 *  hosted-addressing rewrite in middleware.js, the plain Request's own
 *  `.url` string does NOT reflect the rewritten path (confirmed live -- it
 *  still reads back the client's original, un-prefixed path/host), even
 *  though Next.js's own dynamic route matching (`params.bucket`/
 *  `params.key` in the calling route file) DID resolve correctly, since
 *  that match runs against the rewritten target. Re-parsing `req.url` for
 *  the bucket/key used in SCOPE ENFORCEMENT would therefore silently
 *  disagree with the bucket/key the route actually operates on for any
 *  virtual-hosted request -- routes now pass their own authoritative
 *  `params` explicitly. Checked with `"key" in routeParams` rather than
 *  `??`, since a real bucket-level route's `key` is legitimately `null`
 *  (nullish), which `??` would otherwise treat as "not provided" and
 *  incorrectly fall through to re-deriving from the URL. */
export async function authenticateS3Request(req, bodyBuffer, routeParams) {
  const url = new URL(req.url);
  const derived = deriveRequestTarget(url);
  const bucket = routeParams && "bucket" in routeParams ? routeParams.bucket : derived.bucket;
  const key = routeParams && "key" in routeParams ? routeParams.key : derived.key;
  const operation = OPERATION_BY_METHOD[req.method] || "READ";

  let credential, owner, accessKeyId;

  if (url.searchParams.has("X-Inaya-Algorithm")) {
    const result = await verifySignedUrl(url, { method: req.method, bucket, key });
    if (!result.ok) {
      const code = result.reason === "SignedUrlExpired" ? "SignedUrlExpired" : result.reason === "RevokedOrUnknownCreator" ? "InvalidAccessKeyId" : "SignatureDoesNotMatch";
      throw new S3AuthError(code, `Signed URL rejected: ${result.reason}.`, 403);
    }
    credential = result.credential;
    owner = credential.owner;
    accessKeyId = credential.accessKeyId;
  } else {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) throw new S3AuthError("AccessDenied", "Missing Authorization header.", 403);

    if (authHeader.startsWith("Bearer ")) {
      ({ owner, accessKeyId } = await authenticateViaGoogleOAuth(authHeader.slice("Bearer ".length).trim()));
      // Google-OAuth-authenticated requests carry the org's full
      // membership-derived access, exactly like the Entra path -- there is
      // no s3_credentials row (and therefore no stored .scope) to check a
      // narrower grant against, matching how Entra auth already bypasses
      // the credential store entirely.
      return { owner, accessKeyId };
    }

    const accessKeyIdMatch = authHeader.match(/Credential=([^/]+)/);
    if (!accessKeyIdMatch) throw new S3AuthError("AccessDenied", "Malformed Authorization header.", 403);

    credential = await resolveS3Credential(accessKeyIdMatch[1]);
    if (!credential) throw new S3AuthError("InvalidAccessKeyId", "The access key ID you provided does not exist or has been revoked.", 403);

    const result = verifySigV4Request({ method: req.method, url, headers: req.headers, bodyBuffer, secretAccessKey: credential.secretAccessKey });
    if (!result.ok) throw new S3AuthError("SignatureDoesNotMatch", result.reason || "The request signature does not match.", 403);
    owner = credential.owner;
    accessKeyId = credential.accessKeyId;
  }

  // A bucket/prefix-scoped credential has no legitimate reason to enumerate
  // every bucket the owner has (ListBuckets, GET /) -- real IAM-style
  // scoping denies rather than silently returning an unfiltered list.
  if (credential.scope?.bucket && !bucket) {
    throw new S3AuthError("AccessDenied", "This credential is scoped to a specific bucket and cannot list all buckets.", 403);
  }
  const scopeCheck = checkScope(credential, { bucket, key, operation });
  if (!scopeCheck.allowed) {
    throw new S3AuthError(scopeCheck.reason === "CredentialExpired" ? "ExpiredToken" : "AccessDenied", `Denied by credential scope: ${scopeCheck.reason}.`, 403);
  }

  return { owner, accessKeyId };
}
