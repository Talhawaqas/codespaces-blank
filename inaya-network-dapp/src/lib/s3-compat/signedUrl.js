// src/lib/s3-compat/signedUrl.js
//
// GCS Compatibility Extension SOW, Phase 2 -- temporary, object-specific
// signed download URLs. Deliberately an Inaya-specific query-string
// scheme (X-Inaya-*), not a reimplementation of AWS SigV4's own presigned-
// URL query-canonicalization algorithm or GCS's V4 signed URLs -- sigv4.js
// already documents header-based signing as this layer's real, tested
// surface, and building a byte-exact SigV4-presigned-URL verifier is
// materially more work than this SOW's own Phase 2 requirements actually
// need (object identity, method, expiration, signature integrity,
// authorization inherited from creator, org isolation -- all satisfied
// here without duplicating SigV4's own canonical-query-string algorithm).
// Disclosed plainly, not presented as AWS/GCS presigned-URL compatible.
//
// Signature covers method + bucket/key + expiry, keyed by the SAME
// secretAccessKey every HMAC credential already has -- no new secret type,
// no new credential store. A signed URL can therefore never grant more
// than its creator's own credential already permits: verification re-
// resolves that same credential and re-runs the SAME checkScope() every
// other request path already enforces.

import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveS3Credential } from "./credentials.js";

const ALGORITHM = "INAYA-HMAC-SHA256";

function stringToSign({ method, bucket, key, expires }) {
  return `${method}\n${bucket}/${key}\n${expires}`;
}

function sign(secretAccessKey, message) {
  return createHmac("sha256", secretAccessKey).update(message, "utf8").digest("hex");
}

/** Returns the full query string to append to a GET/HEAD object URL.
 *  `expiresInSeconds` is capped at 7 days, matching real S3/GCS presigned-
 *  URL maximum-lifetime conventions -- an unboundedly long-lived "temporary"
 *  URL isn't temporary. */
export function createSignedUrl({ accessKeyId, secretAccessKey, method, bucket, key, expiresInSeconds = 3600 }) {
  const cappedTtl = Math.min(Math.max(1, expiresInSeconds), 7 * 24 * 3600);
  const expires = Math.floor(Date.now() / 1000) + cappedTtl;
  const signature = sign(secretAccessKey, stringToSign({ method, bucket, key, expires }));
  const params = new URLSearchParams({
    "X-Inaya-Algorithm": ALGORITHM,
    "X-Inaya-Credential": accessKeyId,
    "X-Inaya-Expires": String(expires),
    "X-Inaya-Signature": signature,
  });
  return params.toString();
}

/** Verifies a signed-URL request. `url` is the full request URL (its
 *  search params carry the X-Inaya-* fields); `method`/`bucket`/`key` come
 *  from the request itself, never re-trusted from the query string, so a
 *  modified object path or method breaks the signature rather than being
 *  silently accepted. Returns { ok: true, credential } or { ok: false,
 *  reason }. Never throws -- callers decide how to map a rejection to an
 *  S3-shaped error. */
export async function verifySignedUrl(url, { method, bucket, key }) {
  const params = url.searchParams;
  if (params.get("X-Inaya-Algorithm") !== ALGORITHM) return { ok: false, reason: "NotASignedUrlRequest" };

  const accessKeyId = params.get("X-Inaya-Credential");
  const expiresRaw = params.get("X-Inaya-Expires");
  const signature = params.get("X-Inaya-Signature");
  if (!accessKeyId || !expiresRaw || !signature) return { ok: false, reason: "MalformedSignedUrl" };

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires)) return { ok: false, reason: "MalformedSignedUrl" };
  if (Math.floor(Date.now() / 1000) > expires) return { ok: false, reason: "SignedUrlExpired" };

  if (!bucket || !key) return { ok: false, reason: "SignedUrlRequiresAnObjectKey" };
  if (method !== "GET" && method !== "HEAD") return { ok: false, reason: "UnauthorizedMethod" };

  const credential = await resolveS3Credential(accessKeyId);
  if (!credential) return { ok: false, reason: "RevokedOrUnknownCreator" };

  // GET and HEAD share one signature (HEAD is a read of the same object
  // identity) -- sign against GET canonically so creating a URL once
  // covers both without a client needing to know which verb it'll issue.
  const expectedSignature = sign(credential.secretAccessKey, stringToSign({ method: "GET", bucket, key, expires }));
  const provided = Buffer.from(signature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "InvalidSignature" };
  }

  return { ok: true, credential };
}

/** The URL a client should actually use for a presigned link. A virtual-hosted request
 *  (<bucket>.<S3_COMPAT_VIRTUAL_HOST_BASE>) is rewritten by middleware to the internal path-style URL, so
 *  `req.url` no longer says what the caller typed: answer in the form the caller used, on the origin the caller
 *  used, taken from the forwarded host/protocol headers rather than the internal URL. */
export function clientFacingPresignedUrl({ headers, url, bucket, key, queryString, virtualHostBase = process.env.S3_COMPAT_VIRTUAL_HOST_BASE || "" }) {
  const host = (headers.get("x-forwarded-host") || headers.get("host") || url.host).split(",")[0].trim();
  const proto = (headers.get("x-forwarded-proto") || url.protocol.replace(":", "")).split(",")[0].trim();
  const hostNoPort = host.toLowerCase().split(":")[0];
  const base = virtualHostBase.toLowerCase().split(":")[0];
  if (base && hostNoPort === `${bucket.toLowerCase()}.${base}`) {
    return `${proto}://${host}/${key.split("/").map(encodeURIComponent).join("/")}?${queryString}`;
  }
  return `${proto}://${host}${url.pathname}?${queryString}`;
}
