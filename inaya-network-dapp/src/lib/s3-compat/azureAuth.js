// src/lib/s3-compat/azureAuth.js
//
// Azure Storage "Shared Key" authorization -- Workstream B. Real algorithm
// from Microsoft's own spec (StringToSign built from a fixed header list +
// CanonicalizedHeaders (x-ms-*) + CanonicalizedResource), verified against
// the real @azure/storage-blob SDK during testing, not a simplified
// approximation. Reuses the exact same S3 credential store (credentials.js)
// as Workstream A -- an Inaya accessKeyId doubles as the Azure "account
// name" and the secretAccessKey as the "account key", so issuing one
// credential works for both protocols with no separate Azure-only
// credential system to keep in sync.
//
// Reference: https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key

import { createHmac, timingSafeEqual } from "node:crypto";

export function parseSharedKeyHeader(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^SharedKey\s+([^:]+):(.+)$/);
  if (!match) return null;
  return { account: match[1], signature: match[2] };
}

function canonicalizedHeaders(headers) {
  const msHeaders = [];
  for (const [key, value] of headers.entries()) {
    if (key.startsWith("x-ms-")) msHeaders.push([key, value]);
  }
  msHeaders.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return msHeaders.map(([k, v]) => `${k}:${v}\n`).join("");
}

function canonicalizedResource(account, pathname, searchParams) {
  // Confirmed against @azure/storage-common's own StorageSharedKeyCredentialPolicy
  // source (getURLPath = new URL(url).pathname, used as-is, un-stripped) --
  // the real SDK signs the FULL request path, including whatever prefix the
  // custom endpoint URL carries. Do not strip /api/azure here.
  let resource = `/${account}${pathname}`;
  const grouped = new Map();
  for (const [key, value] of searchParams.entries()) {
    const lower = key.toLowerCase();
    if (!grouped.has(lower)) grouped.set(lower, []);
    grouped.get(lower).push(value);
  }
  const sortedKeys = [...grouped.keys()].sort();
  for (const key of sortedKeys) {
    resource += `\n${key}:${grouped.get(key).sort().join(",")}`;
  }
  return resource;
}

/** Verifies an Azure Shared Key-signed request. `bodyBuffer` must be the raw,
 *  unparsed body. Returns { ok: true, account } or { ok: false, reason }. */
export function verifySharedKeyRequest({ method, url, headers, bodyBuffer, accountKey }) {
  const authHeader = headers.get("authorization");
  const parsed = parseSharedKeyHeader(authHeader);
  if (!parsed) return { ok: false, reason: "Missing or malformed Authorization header (expected SharedKey account:signature)." };

  const msDate = headers.get("x-ms-date");
  if (!msDate) return { ok: false, reason: "Missing x-ms-date header." };
  const requestTime = new Date(msDate).getTime();
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 15 * 60 * 1000) {
    return { ok: false, reason: "Request timestamp (x-ms-date) is outside the allowed 15-minute window." };
  }

  // Order and the Content-Length "0" -> "" special case both confirmed
  // against @azure/storage-common's own StorageSharedKeyCredentialPolicy
  // source: Content-Language precedes Content-Encoding (easy to get
  // backwards -- Azure's own docs list them the more "expected" way
  // round), and a Content-Length header literally equal to "0" is signed
  // as an empty string, not "0".
  const contentLengthHeader = headers.get("content-length");
  const contentLength = !contentLengthHeader || contentLengthHeader === "0" ? "" : contentLengthHeader;
  // NOTE: canonicalizedHeaders() already ends with its own trailing "\n" (one
  // per header line) -- it must be concatenated directly against
  // canonicalizedResource, NOT joined with an extra "\n" separator, or the
  // string carries a spurious blank line the real algorithm never has. A
  // real bug found here during Azure SDK interop debugging: the fixed
  // 12-field block is what gets joined with "\n"; canonicalizedHeaders and
  // canonicalizedResource are appended after with no separator of their own.
  const stringToSign =
    [
      method.toUpperCase(),
      headers.get("content-language") || "",
      headers.get("content-encoding") || "",
      contentLength,
      headers.get("content-md5") || "",
      headers.get("content-type") || "",
      "", // Date -- empty because x-ms-date is used instead, per spec
      headers.get("if-modified-since") || "",
      headers.get("if-match") || "",
      headers.get("if-none-match") || "",
      headers.get("if-unmodified-since") || "",
      headers.get("range") || "",
    ].join("\n") +
    "\n" +
    canonicalizedHeaders(headers) +
    canonicalizedResource(parsed.account, url.pathname, url.searchParams);

  const keyBuffer = Buffer.from(accountKey, "base64");
  const expectedSignature = createHmac("sha256", keyBuffer).update(stringToSign, "utf8").digest("base64");

  const provided = Buffer.from(parsed.signature, "base64");
  const expected = Buffer.from(expectedSignature, "base64");
  const match = provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!match) return { ok: false, reason: "SignatureDoesNotMatch" };
  return { ok: true, account: parsed.account };
}
