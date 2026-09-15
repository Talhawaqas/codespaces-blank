// test/s3-compat-sigv4.test.mjs
//
// Multi-Cloud Enterprise Storage Compatibility SOW, Workstream A — pure
// unit tests for the AWS SigV4 verifier (src/lib/s3-compat/sigv4.js). No
// database, no network: these test the actual cryptographic algorithm
// (canonical request -> string to sign -> derived key -> HMAC) against
// hand-built requests, independent of the real end-to-end verification
// already exercised live against the real AWS CLI during development
// (see the SOW report for that manual run's results).
//
// Run with: node --env-file=.env.local --test test/s3-compat-sigv4.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { verifySigV4Request, parseAuthorizationHeader } from "../src/lib/s3-compat/sigv4.js";

const SECRET = "testSecretAccessKey1234567890";
const ACCESS_KEY = "INAYAAKTEST0000000000000001";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Builds a real, correctly-signed request the same way the AWS SDK/CLI
 *  would, so tests exercise the exact algorithm the verifier implements. */
function signRequest({ method, path, query = "", headers, bodyBuffer = Buffer.alloc(0), secretAccessKey = SECRET, accessKeyId = ACCESS_KEY, date, region = "us-east-1", service = "s3" }) {
  const amzDate = date || new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const allHeaders = { host: "localhost:3000", "x-amz-date": amzDate, "x-amz-content-sha256": sha256Hex(bodyBuffer), ...headers };
  const signedHeaderNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${allHeaders[k]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, sha256Hex(bodyBuffer)].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headerMap = new Map(Object.entries(allHeaders));
  headerMap.set("authorization", authorization);

  return {
    method,
    url: new URL(`http://localhost:3000${path}${query ? "?" + query : ""}`),
    headers: { get: (name) => headerMap.get(name.toLowerCase()) || null },
    bodyBuffer,
  };
}

test("verifySigV4Request accepts a correctly-signed request", () => {
  const req = signRequest({ method: "GET", path: "/test-bucket" });
  const result = verifySigV4Request({ ...req, secretAccessKey: SECRET });
  assert.equal(result.ok, true);
  assert.equal(result.accessKeyId, ACCESS_KEY);
});

test("verifySigV4Request rejects a wrong secret", () => {
  const req = signRequest({ method: "GET", path: "/test-bucket" });
  const result = verifySigV4Request({ ...req, secretAccessKey: "aDifferentWrongSecret" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SignatureDoesNotMatch");
});

test("verifySigV4Request rejects a tampered path (signature no longer matches)", () => {
  const req = signRequest({ method: "GET", path: "/test-bucket" });
  const tamperedReq = { ...req, url: new URL("http://localhost:3000/a-different-bucket") };
  const result = verifySigV4Request({ ...tamperedReq, secretAccessKey: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SignatureDoesNotMatch");
});

test("verifySigV4Request rejects a tampered body (payload hash no longer matches)", () => {
  const bodyBuffer = Buffer.from("original content");
  const req = signRequest({ method: "PUT", path: "/test-bucket/key.txt", bodyBuffer });
  const tamperedReq = { ...req, bodyBuffer: Buffer.from("tampered content") };
  const result = verifySigV4Request({ ...tamperedReq, secretAccessKey: SECRET });
  assert.equal(result.ok, false);
});

test("verifySigV4Request rejects a request signed too long ago (replay protection)", () => {
  const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/[:-]|\.\d{3}/g, ""); // 1 hour ago
  const req = signRequest({ method: "GET", path: "/test-bucket", date: oldDate });
  const result = verifySigV4Request({ ...req, secretAccessKey: SECRET });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timestamp/i);
});

test("verifySigV4Request rejects a missing Authorization header", () => {
  const result = verifySigV4Request({
    method: "GET",
    url: new URL("http://localhost:3000/test-bucket"),
    headers: { get: () => null },
    bodyBuffer: Buffer.alloc(0),
    secretAccessKey: SECRET,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Authorization/i);
});

test("parseAuthorizationHeader extracts the real fields from a real header shape", () => {
  const parsed = parseAuthorizationHeader(
    "AWS4-HMAC-SHA256 Credential=INAYAAKTEST/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=" + "a".repeat(64)
  );
  assert.equal(parsed.accessKeyId, "INAYAAKTEST");
  assert.equal(parsed.date, "20260101");
  assert.equal(parsed.region, "us-east-1");
  assert.equal(parsed.service, "s3");
  assert.deepEqual(parsed.signedHeaders, ["host", "x-amz-date"]);
});

test("parseAuthorizationHeader returns null for a malformed header rather than throwing", () => {
  assert.equal(parseAuthorizationHeader("not a real header"), null);
  assert.equal(parseAuthorizationHeader(""), null);
  assert.equal(parseAuthorizationHeader(null), null);
});

test("verifySigV4Request accepts UNSIGNED-PAYLOAD without hashing the body", () => {
  const req = signRequest({ method: "PUT", path: "/test-bucket/key.txt", headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" }, bodyBuffer: Buffer.from("irrelevant") });
  // Re-sign with the literal UNSIGNED-PAYLOAD marker in place of the real body hash in the canonical request.
  const amzDate = req.headers.get("x-amz-date");
  const dateStamp = amzDate.slice(0, 8);
  const allHeaders = { host: "localhost:3000", "x-amz-date": amzDate, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" };
  const signedHeaderNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${allHeaders[k]}\n`).join("");
  const canonicalRequest = ["PUT", "/test-bucket/key.txt", "", canonicalHeaders, signedHeaderNames.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const credentialScope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + SECRET, dateStamp);
  const kRegion = hmac(kDate, "us-east-1");
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;

  const headerMap = new Map(Object.entries(allHeaders));
  headerMap.set("authorization", authorization);
  const result = verifySigV4Request({
    method: "PUT",
    url: new URL("http://localhost:3000/test-bucket/key.txt"),
    headers: { get: (name) => headerMap.get(name.toLowerCase()) || null },
    bodyBuffer: Buffer.from("anything -- unsigned payload means the body itself isn't part of the signature"),
    secretAccessKey: SECRET,
  });
  assert.equal(result.ok, true);
});
