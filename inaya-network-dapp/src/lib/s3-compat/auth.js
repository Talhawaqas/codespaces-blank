// src/lib/s3-compat/auth.js
//
// Ties credential resolution (credentials.js) to signature verification
// (sigv4.js) into the one function every S3-compat route calls. Mirrors
// api-keys.js's requireApiKey() shape (returns { orgId, accessKeyId } or
// throws an S3AuthError the route maps to a real S3-shaped error response)
// so auth here reads the same way every other route's auth check does.

import { resolveS3Credential, checkScope } from "./credentials.js";
import { verifySigV4Request } from "./sigv4.js";

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
 *  bucket/key every route handler itself will act on. */
function deriveRequestTarget(url) {
  const segments = url.pathname.replace(/^\/api\/s3\/?/, "").split("/").filter(Boolean);
  const bucket = segments[0] || null;
  const key = segments.length > 1 ? segments.slice(1).join("/") : null;
  return { bucket, key };
}

/** `bodyBuffer` must be the raw request body read BEFORE any parsing -- S3
 *  payloads are arbitrary binary. Returns { owner, accessKeyId } where owner
 *  is { type: "org", orgId } or { type: "wallet", walletAddress }. Enforces
 *  the credential's stored scope (if any) server-side, in addition to
 *  signature verification -- a valid signature alone is no longer
 *  sufficient once a credential carries a narrower grant than its owner's
 *  full access. */
export async function authenticateS3Request(req, bodyBuffer) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new S3AuthError("AccessDenied", "Missing Authorization header.", 403);

  const accessKeyIdMatch = authHeader.match(/Credential=([^/]+)/);
  if (!accessKeyIdMatch) throw new S3AuthError("AccessDenied", "Malformed Authorization header.", 403);

  const credential = await resolveS3Credential(accessKeyIdMatch[1]);
  if (!credential) throw new S3AuthError("InvalidAccessKeyId", "The access key ID you provided does not exist or has been revoked.", 403);

  const url = new URL(req.url);
  const result = verifySigV4Request({
    method: req.method,
    url,
    headers: req.headers,
    bodyBuffer,
    secretAccessKey: credential.secretAccessKey,
  });

  if (!result.ok) throw new S3AuthError("SignatureDoesNotMatch", result.reason || "The request signature does not match.", 403);

  const { bucket, key } = deriveRequestTarget(url);
  const operation = OPERATION_BY_METHOD[req.method] || "READ";
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

  return { owner: credential.owner, accessKeyId: credential.accessKeyId };
}
