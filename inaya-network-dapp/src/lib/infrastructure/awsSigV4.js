// src/lib/infrastructure/awsSigV4.js
//
// Gap-closure round, Phase B (closes INFRA-AWS-001/002): real AWS Signature
// Version 4 request verification -- the real canonical-request construction
// and the real kDate->kRegion->kService->kSigning HMAC chain, not a
// lookalike. This is what lets the real `aws` CLI / botocore / boto3 sign a
// request the normal way and have it verified here; a hand-rolled "looks
// like SigV4" check would not actually interoperate with those real tools.
//
// Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** AWS's own URI-encoding rules for SigV4 (RFC 3986 unreserved set, plus
 *  the documented exceptions) -- NOT encodeURIComponent's rules, which
 *  differ on a few characters (`!`, `*`, `'`, `(`, `)`) that AWS requires
 *  percent-encoded and JS leaves literal. */
function awsUriEncode(str, encodeSlash = true) {
  return Array.from(Buffer.from(str, "utf8"))
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-_.~]/.test(ch)) return ch;
      if (ch === "/" && !encodeSlash) return ch;
      return "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

function canonicalUri(pathname) {
  if (!pathname || pathname === "") return "/";
  return pathname
    .split("/")
    .map((seg) => awsUriEncode(decodeURIComponent(seg), false))
    .join("/");
}

function canonicalQueryString(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams.entries()) pairs.push([awsUriEncode(k), awsUriEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** `headers` is a plain object of lowercased header-name -> value (the
 *  caller is responsible for lowercasing, matching how Next.js's own
 *  Headers iteration already yields them). `signedHeaderNames` is the
 *  ordered, semicolon-joined list from the request's own Authorization
 *  header -- SigV4 only includes the headers the client itself chose to
 *  sign, never "every header this server happened to receive". */
function canonicalHeaders(headers, signedHeaderNames) {
  return signedHeaderNames.map((name) => `${name}:${(headers[name] || "").trim().replace(/\s+/g, " ")}\n`).join("");
}

function buildCanonicalRequest({ method, pathname, searchParams, headers, signedHeaderNames, payloadHashHex }) {
  return [method.toUpperCase(), canonicalUri(pathname), canonicalQueryString(searchParams), canonicalHeaders(headers, signedHeaderNames), signedHeaderNames.join(";"), payloadHashHex].join("\n");
}

function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

const AUTH_HEADER_RE = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/;

export class SigV4Error extends Error {}

/** Pulls just the access key ID out of a real Authorization header, for
 *  callers (the EC2 route) that need to look up the matching secret from
 *  an async store BEFORE calling the (synchronous) verifySigV4 below --
 *  verification itself still re-validates the full header, this is only
 *  a cheap pre-lookup key, never trusted on its own. */
export function extractAccessKeyId(authHeader) {
  const match = AUTH_HEADER_RE.exec((authHeader || "").trim());
  return match ? match[1] : null;
}

/** Verifies a real AWS SigV4 `Authorization` header against a secret key.
 *  Returns `{ accessKeyId, region, service }` on success; throws SigV4Error
 *  on any mismatch -- never returns a partial or "probably fine" result. */
export function verifySigV4({ method, url, headers, body, getSecretForAccessKey, maxSkewMs = 15 * 60 * 1000 }) {
  const authHeader = headers["authorization"];
  if (!authHeader) throw new SigV4Error("Missing Authorization header.");
  const match = AUTH_HEADER_RE.exec(authHeader.trim());
  if (!match) throw new SigV4Error("Authorization header is not a well-formed AWS4-HMAC-SHA256 signature.");
  const [, accessKeyId, dateStamp, region, service, signedHeadersRaw, providedSignature] = match;

  const amzDate = headers["x-amz-date"];
  if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate)) throw new SigV4Error("Missing or malformed x-amz-date header.");
  if (!amzDate.startsWith(dateStamp)) throw new SigV4Error("x-amz-date does not match the credential scope's date.");
  const requestTime = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > maxSkewMs) throw new SigV4Error("Request timestamp is outside the allowed clock-skew window.");

  const secretAccessKey = getSecretForAccessKey(accessKeyId);
  if (!secretAccessKey) throw new SigV4Error("Unknown AWS access key ID.");

  const signedHeaderNames = signedHeadersRaw.split(";");
  const parsedUrl = new URL(url);
  const payloadHashHex = headers["x-amz-content-sha256"] && headers["x-amz-content-sha256"] !== "UNSIGNED-PAYLOAD" ? headers["x-amz-content-sha256"] : sha256Hex(body || "");

  const canonicalRequest = buildCanonicalRequest({ method, pathname: parsedUrl.pathname, searchParams: parsedUrl.searchParams, headers, signedHeaderNames, payloadHashHex });
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const expectedSignature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const a = Buffer.from(expectedSignature, "utf8");
  const b = Buffer.from(providedSignature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new SigV4Error("Signature verification failed.");

  return { accessKeyId, region, service };
}

// Exported for the fixed-vector unit tests below and for anything that
// wants to sign a request the same way (e.g. a test client exercising this
// module against itself, or awsEc2Xml's own test fixtures).
export const _internal = { sha256Hex, hmac, awsUriEncode, canonicalUri, canonicalQueryString, canonicalHeaders, buildCanonicalRequest, deriveSigningKey };
