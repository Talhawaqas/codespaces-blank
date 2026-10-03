// test/s3-presign-origin.test.mjs -- the presigned link a client is handed uses the origin and address form it called with.
// Run: node --env-file=.env.local --test --test-force-exit test/s3-presign-origin.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFacingPresignedUrl } from "../src/lib/s3-compat/signedUrl.js";

const BASE = "s3.inayanetwork.com";
const call = (headers, internalUrl, key = "dir/file name.txt", virtualHostBase = BASE) =>
  clientFacingPresignedUrl({ headers: new Headers(headers), url: new URL(internalUrl), bucket: "photos", key, queryString: "X-Inaya-Signature=abc", virtualHostBase });

test("path-style: the public host and protocol from the forwarded headers replace the internal origin", () => {
  const out = call({ "x-forwarded-host": "www.inayanetwork.com", "x-forwarded-proto": "https", host: "internal:3000" }, "http://internal:3000/api/s3/photos/dir/file%20name.txt");
  assert.equal(out, "https://www.inayanetwork.com/api/s3/photos/dir/file%20name.txt?X-Inaya-Signature=abc");
});

test("virtual-hosted: a request to <bucket>.<base> gets a virtual-hosted link, not the rewritten path-style one", () => {
  // middleware rewrote https://photos.s3.inayanetwork.com/dir/file%20name.txt to /api/s3/photos/dir/file%20name.txt
  const out = call({ host: "photos.s3.inayanetwork.com", "x-forwarded-proto": "https" }, "https://photos.s3.inayanetwork.com/api/s3/photos/dir/file%20name.txt");
  assert.equal(out, "https://photos.s3.inayanetwork.com/dir/file%20name.txt?X-Inaya-Signature=abc");
});

test("virtual-hosted keeps a custom port and encodes every key segment", () => {
  const out = call({ host: "photos.s3.inayanetwork.com:8443", "x-forwarded-proto": "https" }, "https://photos.s3.inayanetwork.com:8443/api/s3/photos/a", "a/b c/ü+.txt");
  assert.equal(out, "https://photos.s3.inayanetwork.com:8443/a/b%20c/%C3%BC%2B.txt?X-Inaya-Signature=abc");
});

test("a different bucket's host, or no virtual-host base configured, stays path-style", () => {
  const otherBucket = call({ host: "videos.s3.inayanetwork.com", "x-forwarded-proto": "https" }, "https://videos.s3.inayanetwork.com/api/s3/photos/k");
  assert.ok(otherBucket.includes("/api/s3/photos/k"), "host does not match this bucket, so no virtual-hosted form");
  const unconfigured = call({ host: "photos.s3.inayanetwork.com", "x-forwarded-proto": "https" }, "https://photos.s3.inayanetwork.com/api/s3/photos/k", "k", "");
  assert.ok(unconfigured.includes("/api/s3/photos/k"));
});

test("with no forwarded headers it falls back to the request's own origin (local dev)", () => {
  const out = clientFacingPresignedUrl({ headers: new Headers(), url: new URL("http://localhost:3000/api/s3/photos/k"), bucket: "photos", key: "k", queryString: "q=1", virtualHostBase: "" });
  assert.equal(out, "http://localhost:3000/api/s3/photos/k?q=1");
});
