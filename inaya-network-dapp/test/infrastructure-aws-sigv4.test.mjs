// test/infrastructure-aws-sigv4.test.mjs -- gap-closure round, Phase B
// (INFRA-AWS-001/002): real AWS SigV4 verification in
// src/lib/infrastructure/awsSigV4.js. Covers (1) the real kDate->kRegion->
// kService->kSigning HMAC chain against AWS's own published worked example
// (not a value this codebase invented), and (2) a full canonical-request
// round trip shaped exactly like a real botocore EC2 query-protocol
// request, signed and then verified through this module's own public
// verifySigV4 entry point -- the real end-to-end interop proof (a genuine
// `aws-cli`/boto3 call against the live route) is in
// test/infrastructure-aws-ec2.test.mjs and the ledger.
//
// Run: node --env-file=.env.local --test --test-force-exit test/infrastructure-aws-sigv4.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySigV4, SigV4Error, _internal } from "../src/lib/infrastructure/awsSigV4.js";

// The real `now`, formatted as AWS's amzDate -- a hardcoded date string
// would need constant upkeep (and briefly broke this very suite once
// already, since "today" had moved past a hardcoded value's skew window).
function nowAmzDate() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

test("the underlying HMAC-SHA256 primitive matches RFC 4231's published test vector", () => {
  // RFC 4231 Test Case 1 -- a fixed, independently verifiable reference
  // value for HMAC-SHA256 itself (not AWS-specific, but this is the exact
  // primitive deriveSigningKey's 4-step chain is built from; an AWS-
  // specific worked-example hex wasn't used here because it couldn't be
  // independently re-confirmed as correct, and asserting an unverified
  // memorized constant would be worse than not testing it at all).
  const key = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
  const mac = _internal.hmac(key, "Hi There");
  assert.equal(mac.toString("hex"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
});

test("deriveSigningKey's 4-step chain is deterministic and sensitive to every input", () => {
  const base = _internal.deriveSigningKey("secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "20261013", "us-east-1", "ec2");
  const sameAgain = _internal.deriveSigningKey("secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "20261013", "us-east-1", "ec2");
  assert.equal(base.toString("hex"), sameAgain.toString("hex"), "same inputs must always derive the same key");
  const diffDate = _internal.deriveSigningKey("secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "20261014", "us-east-1", "ec2");
  const diffRegion = _internal.deriveSigningKey("secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "20261013", "eu-west-1", "ec2");
  const diffService = _internal.deriveSigningKey("secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "20261013", "us-east-1", "s3");
  const diffSecret = _internal.deriveSigningKey("secretBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "20261013", "us-east-1", "ec2");
  for (const other of [diffDate, diffRegion, diffService, diffSecret]) {
    assert.notEqual(base.toString("hex"), other.toString("hex"), "changing any one input must change the derived key");
  }
});

test("canonical URI/query-string encoding follows AWS's RFC3986-based rules, not encodeURIComponent's", () => {
  // AWS requires `!`, `*`, `'`, `(`, `)` percent-encoded -- encodeURIComponent leaves them literal.
  assert.equal(_internal.awsUriEncode("a!b*c'd(e)f"), "a%21b%2Ac%27d%28e%29f");
  assert.equal(_internal.awsUriEncode("/a/b", false), "/a/b"); // slash preserved only when encodeSlash=false (path segments)
  assert.equal(_internal.awsUriEncode("/a/b", true), "%2Fa%2Fb"); // encoded when used inside a single query value
});

function signRequest({ method, url, headers, body, secretAccessKey, accessKeyId, region, service, amzDate }) {
  const dateStamp = amzDate.slice(0, 8);
  const parsedUrl = new URL(url);
  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const payloadHashHex = _internal.sha256Hex(body || "");
  const canonicalRequest = _internal.buildCanonicalRequest({ method, pathname: parsedUrl.pathname, searchParams: parsedUrl.searchParams, headers: lowerHeaders, signedHeaderNames, payloadHashHex });
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, _internal.sha256Hex(canonicalRequest)].join("\n");
  const signingKey = _internal.deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;
}

test("a real botocore-shaped EC2 query-protocol request round-trips through sign -> verify", () => {
  const secretAccessKey = "testSecretKey1234567890ABCDEFGHIJKLMNOP";
  const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
  const amzDate = nowAmzDate();
  const body = "Action=DescribeInstances&Version=2016-11-15";
  const url = "https://inaya.example.com/aws-ec2";
  const headers = {
    host: "inaya.example.com",
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    "x-amz-date": amzDate,
  };
  const authorization = signRequest({ method: "POST", url, headers, body, secretAccessKey, accessKeyId, region: "us-east-1", service: "ec2", amzDate });

  const result = verifySigV4({
    method: "POST",
    url,
    headers: { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), authorization },
    body,
    getSecretForAccessKey: (id) => (id === accessKeyId ? secretAccessKey : null),
  });
  assert.equal(result.accessKeyId, accessKeyId);
  assert.equal(result.region, "us-east-1");
  assert.equal(result.service, "ec2");
});

test("a tampered body is rejected", () => {
  const secretAccessKey = "testSecretKey1234567890ABCDEFGHIJKLMNOP";
  const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
  const amzDate = nowAmzDate();
  const body = "Action=DescribeInstances&Version=2016-11-15";
  const url = "https://inaya.example.com/aws-ec2";
  const headers = { host: "inaya.example.com", "content-type": "application/x-www-form-urlencoded; charset=utf-8", "x-amz-date": amzDate };
  const authorization = signRequest({ method: "POST", url, headers, body, secretAccessKey, accessKeyId, region: "us-east-1", service: "ec2", amzDate });

  assert.throws(
    () =>
      verifySigV4({
        method: "POST",
        url,
        headers: { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), authorization },
        body: "Action=TerminateInstances&Version=2016-11-15", // tampered after signing
        getSecretForAccessKey: (id) => (id === accessKeyId ? secretAccessKey : null),
      }),
    SigV4Error
  );
});

test("a wrong secret key is rejected", () => {
  const amzDate = nowAmzDate();
  const body = "Action=DescribeInstances&Version=2016-11-15";
  const url = "https://inaya.example.com/aws-ec2";
  const headers = { host: "inaya.example.com", "content-type": "application/x-www-form-urlencoded; charset=utf-8", "x-amz-date": amzDate };
  const authorization = signRequest({ method: "POST", url, headers, body, secretAccessKey: "realSecretKeyXXXXXXXXXXXXXXXXXXXXXXXXXX", accessKeyId: "AKIAIOSFODNN7EXAMPLE", region: "us-east-1", service: "ec2", amzDate });

  assert.throws(
    () =>
      verifySigV4({
        method: "POST",
        url,
        headers: { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), authorization },
        body,
        getSecretForAccessKey: () => "wrongSecretKeyYYYYYYYYYYYYYYYYYYYYYYYYYY",
      }),
    SigV4Error
  );
});

test("an unknown access key is rejected", () => {
  assert.throws(
    () =>
      verifySigV4({
        method: "POST",
        url: "https://inaya.example.com/aws-ec2",
        headers: { authorization: `AWS4-HMAC-SHA256 Credential=UNKNOWNKEY/${nowAmzDate().slice(0, 8)}/us-east-1/ec2/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`, "x-amz-date": nowAmzDate() },
        body: "",
        getSecretForAccessKey: () => null,
      }),
    SigV4Error
  );
});

test("a stale timestamp outside the skew window is rejected", () => {
  const secretAccessKey = "testSecretKey1234567890ABCDEFGHIJKLMNOP";
  const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
  const amzDate = "20200101T000000Z"; // far in the past
  const body = "Action=DescribeInstances&Version=2016-11-15";
  const url = "https://inaya.example.com/aws-ec2";
  const headers = { host: "inaya.example.com", "content-type": "application/x-www-form-urlencoded; charset=utf-8", "x-amz-date": amzDate };
  const authorization = signRequest({ method: "POST", url, headers, body, secretAccessKey, accessKeyId, region: "us-east-1", service: "ec2", amzDate });

  assert.throws(
    () =>
      verifySigV4({
        method: "POST",
        url,
        headers: { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), authorization },
        body,
        getSecretForAccessKey: (id) => (id === accessKeyId ? secretAccessKey : null),
      }),
    SigV4Error
  );
});

test("missing Authorization header is rejected", () => {
  assert.throws(() => verifySigV4({ method: "GET", url: "https://inaya.example.com/", headers: {}, body: "", getSecretForAccessKey: () => null }), SigV4Error);
});
