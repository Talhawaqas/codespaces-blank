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
// Supports header-based signing (Authorization: AWS4-HMAC-SHA256 /
// GOOG4-HMAC-SHA256 ...), which is what the AWS CLI, every AWS SDK, gsutil/boto
// configured against a non-Google S3-compatible endpoint, and Google's own
// client libraries (when using HMAC credentials) use by default, AND (SQA-019)
// query-string signing ("presigned URLs", `aws s3 presign`). Status of the
// presigned variants: AWS4 presigned URLs are VERIFIED against the real AWS CLI
// (test/sqa-s3-presign.test.mjs pins URLs it generated, and
// test/sqa-s3-realclient.test.mjs downloads through one); the GOOG4 (X-Goog-*)
// presigned variant uses the same code path but is UNVERIFIED against a real
// Google client (gsutil signurl needs a service-account key, not HMAC keys).

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

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

// SQA-022 (S1): `url.pathname` is ALREADY percent-encoded as the client sent it, so encoding it again turned every escape into %25xx and no request
// for a key containing a space, parenthesis, plus, ampersand or non-ASCII character could ever authenticate (SignatureDoesNotMatch), for header-signed
// and presigned requests alike. Each segment is decoded first and then encoded exactly once (the same RFC 3986 form botocore and the AWS SDKs sign).
function canonicalUri(pathname) {
  return pathname.split("/").map((seg) => sigv4UriEncode(safeDecode(seg))).join("/") || "/";
}

function canonicalQueryString(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "X-Amz-Signature" || key === "X-Goog-Signature") continue;
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

const PRESIGN_MAX_EXPIRES_S = 7 * 24 * 60 * 60; // S3 and GCS both cap a presigned URL at 7 days
const PRESIGN_PARAM_PREFIX = { "AWS4-HMAC-SHA256": "X-Amz-", "GOOG4-HMAC-SHA256": "X-Goog-" };

/** The Credential query parameter of a presigned URL (`AKID/date/region/service/aws4_request`), or null if this request is not a
 *  SigV4/GOOG4 presigned URL. Lets the caller resolve the credential (and its secret) before verifying. */
export function parsePresignedCredential(url) {
  for (const [algorithm, prefix] of Object.entries(PRESIGN_PARAM_PREFIX)) {
    if (url.searchParams.get(`${prefix}Algorithm`) !== algorithm) continue;
    const credential = url.searchParams.get(`${prefix}Credential`);
    if (!credential) return null;
    return { algorithm, prefix, accessKeyId: credential.split("/")[0] };
  }
  return null;
}

/**
 * SQA-019: SigV4 / GOOG4 query-string signing ("presigned URLs": `aws s3 presign`, SDK generate_presigned_url, GCS V4 signed URLs). Same HMAC chain
 * as header signing, with the signature parameters in the query string and an UNSIGNED-PAYLOAD body hash. Checks, in order: the algorithm and
 * credential scope, the signing time and the expiry window (a link is valid from its signing time, with the usual 15-minute clock skew, until
 * signing time + X-Amz-Expires, never more than 7 days), and finally the signature over the canonical request, which binds the METHOD, the exact
 * path, every query parameter and the signed headers -- so a link for GET cannot be replayed as PUT or DELETE and cannot be re-aimed at
 * another key. Returns { ok: true, accessKeyId } or { ok: false, reason }.
 */
export function verifySigV4PresignedRequest({ method, url, headers, secretAccessKey, now = Date.now() }) {
  const found = parsePresignedCredential(url);
  if (!found) return { ok: false, reason: "Not a presigned request." };
  const { algorithm, prefix } = found; const scheme = SCHEMES[algorithm];
  const q = (name) => url.searchParams.get(`${prefix}${name}`);

  const credParts = String(q("Credential") || "").split("/");
  if (credParts.length !== 5 || credParts[4] !== scheme.requestType) return { ok: false, reason: "Malformed presigned credential." };
  const [, date, region, service] = credParts;
  const requestDate = q("Date"); const signedHeadersParam = q("SignedHeaders"); const signature = q("Signature"); const expires = Number(q("Expires"));
  if (!requestDate || !/^\d{8}T\d{6}Z$/.test(requestDate) || !requestDate.startsWith(date)) return { ok: false, reason: "Malformed presigned date." };
  if (!signedHeadersParam || !signature || !/^[a-f0-9]+$/.test(signature)) return { ok: false, reason: "Malformed presigned signature." };
  if (!Number.isInteger(expires) || expires < 1 || expires > PRESIGN_MAX_EXPIRES_S) return { ok: false, reason: "Invalid presigned expiry." };

  const signedAt = Date.parse(`${requestDate.slice(0, 4)}-${requestDate.slice(4, 6)}-${requestDate.slice(6, 8)}T${requestDate.slice(9, 11)}:${requestDate.slice(11, 13)}:${requestDate.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAt)) return { ok: false, reason: "Malformed presigned date." };
  if (now < signedAt - 15 * 60 * 1000) return { ok: false, reason: "Presigned URL is not valid yet." };
  if (now > signedAt + expires * 1000) return { ok: false, reason: "SignedUrlExpired" };

  const signedHeaders = signedHeadersParam.split(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaders(headers, signedHeaders),
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const credentialScope = `${date}/${region}/${service}/${scheme.requestType}`;
  const stringToSign = [algorithm, requestDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey({ secretAccessKey, date, region, service: service || SERVICE, scheme });
  const expected = Buffer.from(createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex"), "hex");
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: "SignatureDoesNotMatch" };
  return { ok: true, accessKeyId: credParts[0] };
}

/** Verifies a signed request -- AWS4-HMAC-SHA256 (real AWS SigV4) or
 *  GOOG4-HMAC-SHA256 (Google Cloud Storage's native V4 scheme), whichever
 *  the Authorization header itself declares (see SCHEMES above). Both are
 *  the identical HMAC-chain algorithm; only header names and a few constant
 *  strings differ. `bodyBuffer` must be the raw, unparsed request body
 *  (Buffer) -- S3/GCS PUT bodies are arbitrary binary, so this must run
 *  before any JSON/text parsing. Returns { ok: true, accessKeyId } or
 *  { ok: false, reason }. */
export function verifySigV4Request({ method, url, headers, bodyBuffer, secretAccessKey, now = Date.now() }) {
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
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > 15 * 60 * 1000) {
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
