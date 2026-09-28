// Security hardening pass (September 2026). Both settings modules deep-merge an org-supplied JSON
// patch over a defaults object with a generic recursive Object.entries loop -- a "__proto__" key,
// which survives JSON.parse as a normal own property, previously reached `out[k] = v`, which DOES
// invoke the real Object.prototype.__proto__ setter and silently swaps the returned object's
// prototype. Proves the fix with the real JSON.parse -> updateSettings round trip an attacker
// would send, not a hand-built object literal.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { getSettings as getBookkeeperSettings, updateSettings as updateBookkeeperSettings } from "../src/lib/bookkeeper/settings.js";
import { getSettings as getSupportSettings, updateSettings as updateSupportSettings } from "../src/lib/support/settings.js";
import clientPromise from "../src/lib/mongodb.js";

const RUN = randomBytes(3).toString("hex");
const created = [];

after(async () => {
  const c = await getOrgCollections();
  await c.orgs.deleteMany({ _id: { $in: created } });
  await c.db.collection("bk_settings").deleteMany({ orgId: { $in: created } });
  await c.db.collection("supportSettings").deleteMany({ orgId: { $in: created } });
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

async function makeOrg(label) {
  await ensureOrgIndexes();
  const c = await getOrgCollections();
  const orgId = (await c.orgs.insertOne({ name: `settings-pollution-${RUN}-${label}`, createdAt: new Date().toISOString() })).insertedId;
  created.push(orgId);
  return orgId;
}

test("a JSON '__proto__' key in a bookkeeper settings patch does not pollute the merged object's prototype", async () => {
  const orgId = await makeOrg("bk");
  const evilPatch = JSON.parse('{"thresholds":{"__proto__":{"polluted":"yes"}}}');
  await updateBookkeeperSettings({ orgId: String(orgId), patch: evilPatch, actorEmail: "x@example.com" }).catch(() => {});
  const settings = await getBookkeeperSettings(String(orgId));
  assert.equal(({}).polluted, undefined, "a brand-new unrelated plain object must never see the polluted property");
  assert.equal(settings.polluted, undefined);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype, "the merged object's own prototype must be untouched");
});

test("a top-level JSON '__proto__' key in a support settings patch does not pollute the merged object's prototype", async () => {
  const orgId = await makeOrg("support");
  const evilPatch = JSON.parse('{"__proto__":{"polluted":"yes"},"portalEnabled":true}');
  const r = await updateSupportSettings({ orgId: String(orgId), patch: evilPatch, actorEmail: "x@example.com" });
  assert.ok(!r.error, JSON.stringify(r));
  assert.equal(r.settings.portalEnabled, true, "a legitimate sibling field in the same patch still applies");
  const settings = await getSupportSettings(String(orgId));
  assert.equal(({}).polluted, undefined, "a brand-new unrelated plain object must never see the polluted property");
  assert.equal(settings.polluted, undefined);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype, "the merged object's own prototype must be untouched");
});
