// SQA-019 / SQA-022 regression tests: SigV4 presigned URLs and percent-encoded object keys.
// The fixtures below were produced by the REAL AWS CLI (botocore) with a fixed throwaway credential:
//   AWS_ACCESS_KEY_ID=INAYAAKFIXTURE000000000001  AWS_SECRET_ACCESS_KEY=fixtureSecretAccessKey0123456789abcd  AWS_DEFAULT_REGION=inaya
//   aws --endpoint-url http://localhost:3000/api/s3 s3 presign "s3://fixture-bucket/dir/file name (v1)+ü&x.bin" --expires-in 3600
// so the verifier is checked against the reference implementation, not against a re-implementation written by the same hands. The clock is pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { verifySigV4Request, verifySigV4PresignedRequest, parsePresignedCredential } from "../src/lib/s3-compat/sigv4.js";

const SECRET = "fixtureSecretAccessKey0123456789abcd"; const KEY = "INAYAAKFIXTURE000000000001";
const SPECIAL = "http://localhost:3000/api/s3/fixture-bucket/dir/file%20name%20%28v1%29%2B%C3%BC%26x.bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=INAYAAKFIXTURE000000000001%2F20260927%2Finaya%2Fs3%2Faws4_request&X-Amz-Date=20260927T010347Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=a221747a3c4c47b60151b780b28b15d1c27d68fc87fce49de7a3ac43893dee43";
const PLAIN = "http://localhost:3000/api/s3/fixture-bucket/plain.bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=INAYAAKFIXTURE000000000001%2F20260927%2Finaya%2Fs3%2Faws4_request&X-Amz-Date=20260927T010349Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=06634ccbaf1d8b612ccaaf7d48801986e02b8af721575efee8b5898094cd4201";
const SIGNED_AT = Date.parse("2026-09-27T01:03:47Z"); const SIGNED_AT_PLAIN = Date.parse("2026-09-27T01:03:49Z");
const headers = () => new Headers({ host: "localhost:3000" });
const verify = (url, { method = "GET", secret = SECRET, now = SIGNED_AT + 60_000 } = {}) => verifySigV4PresignedRequest({ method, url: new URL(url), headers: headers(), secretAccessKey: secret, now });

test("a URL presigned by the real AWS CLI verifies, including a key with spaces, parentheses, plus, ampersand and non-ASCII (SQA-022)", () => {
  assert.equal(parsePresignedCredential(new URL(SPECIAL)).accessKeyId, KEY);
  assert.deepEqual(verify(SPECIAL), { ok: true, accessKeyId: KEY });
  assert.deepEqual(verify(PLAIN, { now: SIGNED_AT_PLAIN + 1000 }), { ok: true, accessKeyId: KEY });
});

test("a presigned URL is bound to its method, its exact path, its query and its secret", () => {
  assert.equal(verify(SPECIAL, { method: "PUT" }).ok, false, "a GET link cannot be replayed as PUT");
  assert.equal(verify(SPECIAL, { method: "DELETE" }).ok, false, "...or DELETE");
  const otherKey = new URL(SPECIAL); otherKey.pathname = "/api/s3/fixture-bucket/dir/other.bin";
  assert.equal(verify(otherKey.href).ok, false, "cannot be re-aimed at another key");
  const extra = new URL(SPECIAL); extra.searchParams.set("versionId", "abc");
  assert.equal(verify(extra.href).ok, false, "adding a query parameter breaks the signature");
  const tampered = new URL(SPECIAL); tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
  assert.equal(verify(tampered.href).ok, false);
  assert.equal(verify(SPECIAL, { secret: "someOtherSecretAccessKey0123456789" }).ok, false, "wrong secret");
});

test("expiry: an expired link, a not-yet-valid link and an out-of-range expiry are all refused; a link inside its window works", () => {
  assert.equal(verify(SPECIAL, { now: SIGNED_AT + 3600_000 + 1000 }).reason, "SignedUrlExpired", "one second past expiry");
  assert.equal(verify(SPECIAL, { now: SIGNED_AT + 3600_000 - 1000 }).ok, true, "one second before expiry");
  assert.equal(verify(SPECIAL, { now: SIGNED_AT - 3600_000 }).ok, false, "a link signed an hour in the future is not valid yet");
  const tooLong = new URL(SPECIAL); tooLong.searchParams.set("X-Amz-Expires", String(8 * 24 * 3600));
  assert.equal(verify(tooLong.href).ok, false, "more than 7 days is refused");
  const zero = new URL(SPECIAL); zero.searchParams.set("X-Amz-Expires", "0");
  assert.equal(verify(zero.href).ok, false);
});

test("a request that is not presigned is not treated as one", () => {
  assert.equal(parsePresignedCredential(new URL("http://localhost:3000/api/s3/b/k")), null);
  assert.equal(verify("http://localhost:3000/api/s3/b/k?X-Amz-Algorithm=AWS4-HMAC-SHA256").ok, false, "algorithm alone, with no credential or signature, is malformed");
});

// A genuine header-signed request captured from the AWS CLI (aws s3api head-object --key "dir/file name (v1)+ü&x.bin"): the key's special characters arrive
// percent-encoded in the path, exactly as every SDK sends them. Before SQA-022 the verifier encoded that path a second time and this could never authenticate.
test("a header-signed request from the real AWS CLI for a key with special characters authenticates (SQA-022)", () => {
  const captured = new Headers({
    host: "localhost:4567", "x-amz-date": "20260927T010432Z", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    authorization: "AWS4-HMAC-SHA256 Credential=INAYAAKFIXTURE000000000001/20260927/inaya/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=514bbd5a33fbdc2f49607375488f6164457c154ebc8933ab77e789833624c3f5",
  });
  const url = new URL("http://localhost:4567/fixture-bucket/dir/file%20name%20%28v1%29%2B%C3%BC%26x.bin");
  const now = Date.parse("2026-09-27T01:04:32Z");
  assert.deepEqual(verifySigV4Request({ method: "HEAD", url, headers: captured, bodyBuffer: Buffer.alloc(0), secretAccessKey: SECRET, now }), { ok: true, accessKeyId: KEY });
  const other = new URL("http://localhost:4567/fixture-bucket/dir/other.bin");
  assert.equal(verifySigV4Request({ method: "HEAD", url: other, headers: captured, bodyBuffer: Buffer.alloc(0), secretAccessKey: SECRET, now }).ok, false, "a different key does not verify");
});
