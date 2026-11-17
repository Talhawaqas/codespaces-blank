// test/csp-policy.test.mjs -- the site-wide Content-Security-Policy (csp.config.mjs, SQA 17 Nov 2026).
// Guards the parts that matter for security so a later edit can't quietly loosen them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentSecurityPolicy } from "../csp.config.mjs";
import nextConfig from "../next.config.mjs";

const parse = (csp) => Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test("scripts only from this site and the named hosts; no plugins, no <base> hijack, no framing by others", () => {
  const p = parse(buildContentSecurityPolicy());
  assert.deepEqual(p["default-src"], ["'self'"]);
  assert.ok(!p["script-src"].includes("https:"), "script-src must not allow every https host");
  assert.ok(!p["script-src"].includes("*"));
  assert.ok(!p["script-src"].includes("data:"));
  assert.deepEqual(p["object-src"], ["'none'"]);
  assert.deepEqual(p["base-uri"], ["'self'"]);
  assert.deepEqual(p["frame-ancestors"], ["'self'"]);
  assert.ok(p["script-src"].includes("https://accounts.google.com"), "Google sign-in still loads");
});

test("next.config sends the full policy on every page, and the Outlook add-in keeps its Office framing and office.js", async () => {
  const rules = await nextConfig.headers();
  const csp = (source) => rules.find((r) => r.source === source).headers.find((h) => h.key === "Content-Security-Policy").value;
  const site = parse(csp("/:path*"));
  assert.deepEqual(site["object-src"], ["'none'"]);
  const outlook = parse(csp("/outlook/:path*"));
  assert.ok(outlook["frame-ancestors"].includes("https://*.office.com"));
  assert.ok(outlook["script-src"].includes("https://appsforoffice.microsoft.com"));
  assert.deepEqual(outlook["object-src"], ["'none'"]);
});
