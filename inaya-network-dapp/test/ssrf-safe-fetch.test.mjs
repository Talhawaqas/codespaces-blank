// Security hardening pass (September 2026). Proves ssrfSafeFetch.js actually blocks the
// attacker-controlled-URL cases it claims to, and still does a real, live HTTPS fetch for a
// genuine public host -- not just a URL-string check with untested request behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { ssrfSafeFetch, assertPublicHttpsUrl } from "../src/lib/ssrfSafeFetch.js";

test("blocks non-https schemes", () => {
  assert.throws(() => assertPublicHttpsUrl("http://example.com"));
  assert.throws(() => assertPublicHttpsUrl("ftp://example.com"));
  assert.throws(() => assertPublicHttpsUrl("file:///etc/passwd"));
  assert.throws(() => assertPublicHttpsUrl("gopher://example.com"));
});

test("blocks embedded credentials in the URL", () => {
  assert.throws(() => assertPublicHttpsUrl("https://user:pass@example.com"));
});

test("blocks loopback, private, link-local and cloud-metadata literal IPs", () => {
  for (const url of [
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://10.0.0.5/",
    "https://172.16.0.5/",
    "https://192.168.1.5/",
    "https://169.254.169.254/latest/meta-data/", // AWS/DigitalOcean metadata
    "https://100.100.100.200/", // Alibaba Cloud metadata
    "https://0.0.0.0/",
  ]) {
    assert.throws(() => assertPublicHttpsUrl(url), `${url} should be blocked`);
  }
});

test("blocks internal-looking hostnames", () => {
  for (const url of ["https://localhost/", "https://foo.localhost/", "https://internal.local/", "https://api.internal/", "https://box.lan/", "https://metadata.google.internal/"]) {
    assert.throws(() => assertPublicHttpsUrl(url), `${url} should be blocked`);
  }
});

test("allows a genuine public https URL through the static check", () => {
  assert.doesNotThrow(() => assertPublicHttpsUrl("https://example.com/.well-known/openid-configuration"));
});

test("a real live fetch to a genuine public host succeeds end to end", async () => {
  const res = await ssrfSafeFetch("https://example.com/", { timeoutMs: 10000 });
  assert.equal(res.ok, true);
  const text = await res.text();
  assert.ok(text.toLowerCase().includes("example domain"), "should get real example.com content back");
});

test("a DNS name that resolves to a private address is blocked at request time, not just by string shape", async () => {
  // localtest.me resolves to 127.0.0.1 publicly -- a real, live example of the "hostname looks
  // public, resolves private" bypass class the custom DNS lookup exists specifically to catch.
  await assert.rejects(() => ssrfSafeFetch("https://localtest.me/", { timeoutMs: 10000 }), /not reachable/i);
});
