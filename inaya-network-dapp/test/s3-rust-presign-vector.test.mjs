// test/s3-rust-presign-vector.test.mjs -- cross-language known-answer test for DirectSync's "Create Secure Link".
// The query string below is produced by inaya-drive-core's Rust presigner (sigv4.rs, test presign_known_answer_vector, fixed
// clock). The server's own verifier -- the one already proven against real AWS SDK presigned URLs -- must accept it for the exact
// method/path/key it was signed for, and reject any tampering. If the Rust signer or the JS verifier drifts, this or the Rust test fails.
// Run: node --test --test-force-exit test/s3-rust-presign-vector.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySigV4PresignedRequest } from "../src/lib/s3-compat/sigv4.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const QUERY = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLEKEY12345%2F20261003%2Finaya%2Fs3%2Faws4_request&X-Amz-Date=20261003T123456Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=9e403ec49d142ae31d6d1e62a9c82c8381622cded4f4e78afc34b2154952d85a";
const SIGNED_AT = Date.parse("2026-10-03T12:34:56Z");
const run = ({ method = "GET", path = "/api/s3/my-bucket/folder/hello%20world.txt", query = QUERY, at = SIGNED_AT + 60_000, secret = SECRET } = {}) =>
  verifySigV4PresignedRequest({ method, url: new URL(`http://127.0.0.1:3000${path}?${query}`), headers: new Headers({ host: "127.0.0.1:3000" }), secretAccessKey: secret, now: at });

test("the server verifier accepts the link the Rust signer produced", () => {
  const r = run();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.accessKeyId, "AKIAEXAMPLEKEY12345");
});

test("and rejects it as a different method, a different key, a different secret, or after it expires", () => {
  assert.equal(run({ method: "PUT" }).ok, false, "a GET link cannot be replayed as PUT");
  assert.equal(run({ method: "DELETE" }).ok, false);
  assert.equal(run({ path: "/api/s3/my-bucket/folder/other.txt" }).ok, false, "cannot be re-aimed at another key");
  assert.equal(run({ secret: SECRET + "x" }).ok, false);
  assert.equal(run({ query: QUERY.replace("Expires=900", "Expires=901") }).ok, false, "expiry is signed");
  assert.equal(run({ at: SIGNED_AT + 901_000 }).reason, "SignedUrlExpired");
});
