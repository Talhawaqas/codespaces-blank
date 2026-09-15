// src/lib/s3-compat/sigv4.js
//
// AWS Signature Version 4 request verification -- the one genuinely new
// cryptographic primitive in this SOW (everything else reuses existing
// Inaya crypto). Implements the real algorithm from AWS's own spec
// (canonical request -> string to sign -> derived signing key -> HMAC),
// verified against real `aws` CLI / `@aws-sdk/client-s3` requests during
// testing -- not a simplified approximation, since a real client computes
// the real thing and expects the server to match it exactly or reject it.
//
// Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-signing.html
//
// Deliberately supports header-based SigV4 only (Authorization: AWS4-HMAC-SHA256 ...),
// which is what the AWS CLI and every AWS SDK use by default for every S3
// operation this SOW's Definition of Done actually requires. Presigned-URL
// query-string signing (`aws s3 presign`) is a real, separate SigV4 variant
// this file does NOT implement -- stated here plainly rather than silently
// half-supported, per the SOW's own "no unverified compatibility claims" rule.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Parses the Authorization header into its Credential/SignedHeaders/Signature parts.
 *  Returns null (never throws) on anything malformed -- callers treat that as a hard
 *  auth failure, same as a missing header. */
export function parseAuthorizationHeader(headerValue) {
  if (!headerValue || !headerValue.startsWith(ALGORITHM)) return null;
  const credMatch = headerValue.match(/Credential=([^,]+)/);
  const signedHeadersMatch = headerValue.match(/SignedHeaders=([^,]+)/);
  const signatureMatch = headerValue.match(/Signature=([a-f0-9]+)/);
  if (!credMatch || !signedHeadersMatch || !signatureMatch) return null;

  const credParts = credMatch[1].split("/");
  if (credParts.length !== 5 || credParts[4] !== "aws4_request") return null;
  const [accessKeyId, date, region, service] = credParts;

  return {
    accessKeyId,
    date,
    region,
    service,
    signedHeaders: signedHeadersMatch[1].split(";"),
    signature: signatureMatch[1],
  };
}

// URI-encodes a single path segment per RFC 3986 the way SigV4 requires --
// encodeURIComponent leaves a few characters SigV4 still wants percent-encoded.
function sigv4UriEncode(str, encodeSlash = false) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, encodeSlash ? "%2F" : "/");
}

function canonicalUri(pathname) {
  return pathname.split("/").map((seg) => sigv4UriEncode(seg)).join("/") || "/";
}

function canonicalQueryString(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "X-Amz-Signature") continue;
    pairs.push([sigv4UriEncode(key, true), sigv4UriEncode(value ?? "", true)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicalHeaders(headers, signedHeaderNames) {
  return signedHeaderNames
    .map((name) => `${name}:${(headers.get(name) || "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
}

function deriveSigningKey({ secretAccessKey, date, region, service }) {
  const kDate = hmac("AWS4" + secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** Verifies a signed request. `bodyBuffer` must be the raw, unparsed request body
 *  (Buffer) -- S3 PUT bodies are arbitrary binary, so this must run before any
 *  JSON/text parsing. Returns { ok: true, accessKeyId } or { ok: false, reason }. */
export function verifySigV4Request({ method, url, headers, bodyBuffer, secretAccessKey }) {
  const authHeader = headers.get("authorization");
  const parsed = parseAuthorizationHeader(authHeader);
  if (!parsed) return { ok: false, reason: "Missing or malformed Authorization header." };

  const amzDate = headers.get("x-amz-date");
  if (!amzDate) return { ok: false, reason: "Missing x-amz-date header." };
  if (!amzDate.startsWith(parsed.date)) return { ok: false, reason: "x-amz-date does not match the credential scope's date." };

  // 15-minute clock-skew window, same tolerance every AWS SDK client itself uses.
  const requestTime = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 15 * 60 * 1000) {
    return { ok: false, reason: "Request timestamp is outside the allowed 15-minute window." };
  }

  const payloadHashHeader = headers.get("x-amz-content-sha256");
  const payloadHash = payloadHashHeader === "UNSIGNED-PAYLOAD" ? "UNSIGNED-PAYLOAD" : sha256Hex(bodyBuffer || Buffer.alloc(0));
  if (payloadHashHeader && payloadHashHeader !== "UNSIGNED-PAYLOAD" && payloadHashHeader !== payloadHash) {
    return { ok: false, reason: "x-amz-content-sha256 does not match the actual request body." };
  }

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaders(headers, parsed.signedHeaders),
    parsed.signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const credentialScope = `${parsed.date}/${parsed.region}/${parsed.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey({ secretAccessKey, date: parsed.date, region: parsed.region, service: parsed.service || SERVICE });
  const expectedSignature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const provided = Buffer.from(parsed.signature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  const signaturesMatch = provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!signaturesMatch) return { ok: false, reason: "SignatureDoesNotMatch" };
  return { ok: true, accessKeyId: parsed.accessKeyId };
}
