// ad-sync-agent/test/offline.test.mjs
//
// Real tests for the parts of this agent that don't need a live DC or a
// live Inaya server: watermark persistence, and the push module's
// signing/body construction (verified against the exact same
// HMAC/timestamp scheme src/lib/identity/normalize.js's
// verifySignature() checks, using a real fetch stand-in so the actual
// request the agent would send is inspected, not assumed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWatermark, writeWatermark } from "../src/watermark.js";
import { pushUser } from "../src/push.js";
import { deriveTenantId } from "../src/agent.js";
import { generalizedTimeToIso } from "../src/ldap.js";

test("watermark: readWatermark returns undefined when no file exists yet (first run = full pull)", () => {
  const p = path.join(os.tmpdir(), `ad-sync-watermark-test-${Date.now()}-missing.json`);
  assert.equal(readWatermark(p), undefined);
});

test("watermark: write then read round-trips the real value", () => {
  const p = path.join(os.tmpdir(), `ad-sync-watermark-test-${Date.now()}.json`);
  writeWatermark(p, 123456);
  assert.equal(readWatermark(p), 123456);
  fs.unlinkSync(p);
});

test("pushUser: signs the request exactly the way the server's verifySignature() checks it", async () => {
  const secret = "idw_test_secret";
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { status: 200, json: async () => ({ status: "PROCESSED" }) };
  };

  const rawAdUser = { objectGUID: "aaaa-bbbb-cccc-dddd", uSNChanged: "500", userPrincipalName: "jdoe@contoso.local" };
  const result = await pushUser({
    inayaBaseUrl: "http://localhost:3000",
    providerId: "670000000000000000000001",
    signingSecret: secret,
    tenantId: "contoso.local",
    rawAdUser,
    fetchImpl,
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "PROCESSED");
  assert.equal(captured.url, "http://localhost:3000/api/integrations/identity/webhooks/670000000000000000000001");

  const body = captured.opts.body;
  const timestamp = captured.opts.headers["X-Inaya-Timestamp"];
  const signature = captured.opts.headers["X-Inaya-Signature"];
  const expectedSig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signature, expectedSig, "signature must match the exact scheme verifySignature() checks");

  const parsed = JSON.parse(body);
  assert.equal(parsed.ad.objectGUID, "aaaa-bbbb-cccc-dddd");
  assert.equal(parsed.eventId, "ad:aaaa-bbbb-cccc-dddd:500", "eventId must be deterministic for real idempotent retries");
  assert.equal(parsed.tenantId, "contoso.local", "tenantId must be sent -- the engine rejects events with no tenantId, or one that doesn't match the provider's own providerTenantId");
});

test("deriveTenantId: derives the real AD domain DNS name from a base DN", () => {
  assert.equal(deriveTenantId("DC=inayatest,DC=local", {}), "inayatest.local");
  assert.equal(deriveTenantId("DC=contoso,DC=com", {}), "contoso.com");
  assert.equal(deriveTenantId("OU=Users,DC=corp,DC=example,DC=co,DC=uk", {}), "corp.example.co.uk", "non-DC components (OU=) are ignored");
});

test("deriveTenantId: AD_TENANT_ID env override wins over derivation", () => {
  assert.equal(deriveTenantId("DC=inayatest,DC=local", { AD_TENANT_ID: "explicit-tenant" }), "explicit-tenant");
});

test("deriveTenantId: throws a clear error for a base DN with no DC components", () => {
  assert.throws(() => deriveTenantId("OU=Users", {}), /Could not derive a tenantId/);
});

test("generalizedTimeToIso: converts a real AD whenChanged value to a real ISO timestamp Date.parse() accepts", () => {
  const iso = generalizedTimeToIso("20261229031500.0Z");
  assert.equal(iso, "2026-12-29T03:15:00.000Z");
  assert.ok(Number.isFinite(Date.parse(iso)), "must be parseable by Date.parse(), matching validateCanonical()'s own check");
});

test("generalizedTimeToIso: handles a timezone-offset form, not just Z", () => {
  const iso = generalizedTimeToIso("20261229031500.0+0500");
  assert.ok(Number.isFinite(Date.parse(iso)));
  assert.equal(new Date(iso).toISOString(), "2026-12-28T22:15:00.000Z");
});

test("generalizedTimeToIso: returns undefined for garbage input rather than throwing", () => {
  assert.equal(generalizedTimeToIso("not-a-timestamp"), undefined);
  assert.equal(generalizedTimeToIso(undefined), undefined);
});

test("pushUser: a trailing slash on inayaBaseUrl doesn't produce a double slash in the URL", async () => {
  let captured;
  const fetchImpl = async (url) => { captured = url; return { status: 200, json: async () => ({}) }; };
  await pushUser({ inayaBaseUrl: "http://localhost:3000/", providerId: "p1", signingSecret: "s", rawAdUser: { objectGUID: "g", uSNChanged: "1" }, fetchImpl });
  assert.equal(captured, "http://localhost:3000/api/integrations/identity/webhooks/p1");
});
