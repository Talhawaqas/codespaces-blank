// src/lib/s3-compat/auth.js
//
// Ties credential resolution (credentials.js) to signature verification
// (sigv4.js) into the one function every S3-compat route calls. Mirrors
// api-keys.js's requireApiKey() shape (returns { orgId, accessKeyId } or
// throws an S3AuthError the route maps to a real S3-shaped error response)
// so auth here reads the same way every other route's auth check does.

import { resolveS3Credential } from "./credentials.js";
import { verifySigV4Request } from "./sigv4.js";

export class S3AuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code; // S3 error <Code> value, e.g. "AccessDenied" | "SignatureDoesNotMatch"
    this.status = status;
  }
}

/** `bodyBuffer` must be the raw request body read BEFORE any parsing -- S3
 *  payloads are arbitrary binary. Returns { owner, accessKeyId } where owner
 *  is { type: "org", orgId } or { type: "wallet", walletAddress }. */
export async function authenticateS3Request(req, bodyBuffer) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new S3AuthError("AccessDenied", "Missing Authorization header.", 403);

  const accessKeyIdMatch = authHeader.match(/Credential=([^/]+)/);
  if (!accessKeyIdMatch) throw new S3AuthError("AccessDenied", "Malformed Authorization header.", 403);

  const credential = await resolveS3Credential(accessKeyIdMatch[1]);
  if (!credential) throw new S3AuthError("InvalidAccessKeyId", "The access key ID you provided does not exist or has been revoked.", 403);

  const result = verifySigV4Request({
    method: req.method,
    url: new URL(req.url),
    headers: req.headers,
    bodyBuffer,
    secretAccessKey: credential.secretAccessKey,
  });

  if (!result.ok) throw new S3AuthError("SignatureDoesNotMatch", result.reason || "The request signature does not match.", 403);

  return { owner: credential.owner, accessKeyId: credential.accessKeyId };
}
