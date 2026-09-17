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
// Google Cloud Storage Compatibility Layer SOW -- generalized (not forked)
// to also accept Google Cloud Storage's native GOOG4-HMAC-SHA256 scheme.
// Per the Phase 0 audit: GCS's XML API documents TWO accepted V4 signing
// modes -- "AWS4-HMAC-SHA256 with x-amz-* interoperability" (byte-identical
// to real AWS SigV4, already fully handled below with zero changes) and its
// own native "GOOG4-HMAC-SHA256" (x-goog-date/x-goog-content-sha256,
// "goog4_request" scope terminator, "GOOG4"+secret key-derivation seed --
// otherwise the exact same HMAC-chain algorithm). The two schemes are
// parameterized here as SCHEMES below rather than duplicated into a second
// file, per the SOW's own "do not fork the SigV4 engine unless a genuine
// incompatibility is proven" instruction -- there is no genuine algorithmic
// incompatibility, only different constant strings and header names.
//
// Deliberately supports header-based signing only (Authorization: AWS4-HMAC-SHA256 /
// GOOG4-HMAC-SHA256 ...), which is what the AWS CLI, every AWS SDK, gsutil/boto
// configured against a non-Google S3-compatible endpoint, and Google's own
// client libraries (when using HMAC credentials) use by default. Presigned/
// signed-URL query-string signing (`aws s3 presign`, GCS V4 signed URLs) is a
// real, separate variant this file does NOT implement -- stated here plainly
// rather than silently half-supported, per this SOW's own "no unverified
// compatibility claims" rule.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SERVICE = "s3";

/** The two supported signing schemes -- same algorithm, different constants.
 *  Detected from the Authorization header's own algorithm prefix, never
 *  assumed from anything else about the request. */
const SCHEMES = {
  "AWS4-HMAC-SHA256": { requestType: "aws4_request", keySeed: "AWS4", dateHeader: "x-amz-date", contentSha256Header: "x-amz-content-sha256" },
  "GOOG4-HMAC-SHA256": { requestType: "goog4_request", keySeed: "GOOG4", dateHeader: "x-goog-date", contentSha256Header: "x-goog-content-sha256" },
};

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Parses the Authorization header into its Algorithm/Credential/SignedHeaders/
 *  Signature parts. Returns null (never throws) on anything malformed or an
 *  unrecognized algorithm -- callers treat that as a hard auth failure, same
 *  as a missing header. */
export function parseAuthorizationHeader(headerValue) {
  if (!headerValue) return null;
  const algorithm = Object.keys(SCHEMES).find((a) => headerValue.startsWith(a));
  if (!algorithm) return null;
  const scheme = SCHEMES[algorithm];

  const credMatch = headerValue.match(/Credential=([^,]+)/);
  const signedHeadersMatch = headerValue.match(/SignedHeaders=([^,]+)/);
  const signatureMatch = headerValue.match(/Signature=([a-f0-9]+)/);
  if (!credMatch || !signedHeadersMatch || !signatureMatch) return null;

  const credParts = credMatch[1].split("/");
  if (credParts.length !== 5 || credParts[4] !== scheme.requestType) return null;
  const [accessKeyId, date, region, service] = credParts;

  return {
    algorithm,
    scheme,
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

function deriveSigningKey({ secretAccessKey, date, region, service, scheme }) {
  const kDate = hmac(scheme.keySeed + secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, scheme.requestType);
}

/** Verifies a signed request -- AWS4-HMAC-SHA256 (real AWS SigV4) or
 *  GOOG4-HMAC-SHA256 (Google Cloud Storage's native V4 scheme), whichever
 *  the Authorization header itself declares (see SCHEMES above). Both are
 *  the identical HMAC-chain algorithm; only header names and a few constant
 *  strings differ. `bodyBuffer` must be the raw, unparsed request body
 *  (Buffer) -- S3/GCS PUT bodies are arbitrary binary, so this must run
 *  before any JSON/text parsing. Returns { ok: true, accessKeyId } or
 *  { ok: false, reason }. */
export function verifySigV4Request({ method, url, headers, bodyBuffer, secretAccessKey }) {
  const authHeader = headers.get("authorization");
  const parsed = parseAuthorizationHeader(authHeader);
  if (!parsed) return { ok: false, reason: "Missing or malformed Authorization header." };
  const { scheme } = parsed;

  const requestDate = headers.get(scheme.dateHeader);
  if (!requestDate) return { ok: false, reason: `Missing ${scheme.dateHeader} header.` };
  if (!requestDate.startsWith(parsed.date)) return { ok: false, reason: `${scheme.dateHeader} does not match the credential scope's date.` };

  // 15-minute clock-skew window, same tolerance every AWS SDK/GCS client itself uses.
  const requestTime = Date.parse(
    `${requestDate.slice(0, 4)}-${requestDate.slice(4, 6)}-${requestDate.slice(6, 8)}T${requestDate.slice(9, 11)}:${requestDate.slice(11, 13)}:${requestDate.slice(13, 15)}Z`
  );
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 15 * 60 * 1000) {
    return { ok: false, reason: "Request timestamp is outside the allowed 15-minute window." };
  }

  const payloadHashHeader = headers.get(scheme.contentSha256Header);
  const payloadHash = payloadHashHeader === "UNSIGNED-PAYLOAD" ? "UNSIGNED-PAYLOAD" : sha256Hex(bodyBuffer || Buffer.alloc(0));
  if (payloadHashHeader && payloadHashHeader !== "UNSIGNED-PAYLOAD" && payloadHashHeader !== payloadHash) {
    return { ok: false, reason: `${scheme.contentSha256Header} does not match the actual request body.` };
  }

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaders(headers, parsed.signedHeaders),
    parsed.signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const credentialScope = `${parsed.date}/${parsed.region}/${parsed.service}/${scheme.requestType}`;
  const stringToSign = [parsed.algorithm, requestDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey({ secretAccessKey, date: parsed.date, region: parsed.region, service: parsed.service || SERVICE, scheme });
  const expectedSignature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const provided = Buffer.from(parsed.signature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  const signaturesMatch = provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!signaturesMatch) return { ok: false, reason: "SignatureDoesNotMatch" };
  return { ok: true, accessKeyId: parsed.accessKeyId };
}
