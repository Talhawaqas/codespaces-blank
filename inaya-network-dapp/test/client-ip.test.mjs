// Security hardening pass (September 2026). getClientIp() now prefers x-vercel-forwarded-for --
// Vercel's own docs describe it as staying authoritative even if the account's x-forwarded-for
// semantics change later (their paid "Trusted Proxy" feature). Confirmed via Vercel's own docs
// (not assumed) that on a normal deployment x-forwarded-for is already server-controlled and not
// client-spoofable; this test proves the header-preference logic itself, not network trust.
import test from "node:test";
import assert from "node:assert/strict";
import { getClientIp } from "../src/lib/rateLimit.js";

const req = (headers) => ({ headers: { get: (k) => headers[k.toLowerCase()] || null } });

test("prefers x-vercel-forwarded-for over x-forwarded-for when both are present", () => {
  assert.equal(getClientIp(req({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })), "203.0.113.9");
});

test("falls back to x-forwarded-for (taking the first entry) when x-vercel-forwarded-for is absent", () => {
  assert.equal(getClientIp(req({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
});

test("falls back to x-real-ip, then a constant, when neither forwarded header is present", () => {
  assert.equal(getClientIp(req({ "x-real-ip": "203.0.113.5" })), "203.0.113.5");
  assert.equal(getClientIp(req({})), "unknown");
});
