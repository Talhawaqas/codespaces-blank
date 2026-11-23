// test/commerce-scanner.test.mjs -- phone as a scanner: the pairing key only adds barcode text to its own till, codes
// arrive in order exactly once, bad input and ended / expired pairings are refused, another company can't read them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as SCAN from "../src/lib/commerce/scanPair.js";

const orgId = new ObjectId(); const ORG = String(orgId); const other = new ObjectId();
const cashier = { role: "member", commerceRole: "cashier", email: "cash@scan.example" }; const none = { role: "member", email: "x@scan.example" };
let c;
before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertMany([{ _id: orgId, name: "scan", features: { FEATURE_COMMERCE: true }, createdAt: now }, { _id: other, name: "scan-other", features: { FEATURE_COMMERCE: true }, createdAt: now }]); });
after(async () => { for (const n of ["orgs", "calendar_records", "org_activity"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: { $in: [orgId, other] } } : { orgId: { $in: [orgId, other] } }).catch(() => {}); await (await mongoClientPromise).close(); });

test("a phone's codes reach its till in order, exactly once; the key is stored only as a hash", { timeout: 120000 }, async () => {
  assert.equal((await SCAN.createScanPair({ orgId: ORG, membership: none, actorEmail: none.email })).code, "COMMERCE_ROLE");
  const p = await SCAN.createScanPair({ orgId: ORG, membership: cashier, actorEmail: cashier.email }); assert.ok(!p.error, p.error);
  assert.ok(p.token.length >= 30);
  const doc = await c.db.collection("calendar_records").findOne({ kind: SCAN.PAIR_KIND, orgId }); assert.ok(!JSON.stringify(doc).includes(p.token), "raw key not stored");
  assert.ok((await SCAN.pairStatus({ token: p.token })).ok);
  for (const code of ["8901234567890", "SKU-1", "8901234567890"]) assert.ok((await SCAN.pushScan({ token: p.token, code })).ok);
  const a = await SCAN.pollScans({ orgId: ORG, membership: cashier, pairId: p.pairId, after: 0 });
  assert.deepEqual(a.codes.map((x) => x.code), ["8901234567890", "SKU-1", "8901234567890"]); assert.ok(a.phoneSeenAt);
  const b = await SCAN.pollScans({ orgId: ORG, membership: cashier, pairId: p.pairId, after: a.seq }); assert.equal(b.codes.length, 0, "nothing twice");
  const [x, y] = await Promise.all([SCAN.pushScan({ token: p.token, code: "A1" }), SCAN.pushScan({ token: p.token, code: "B2" })]); assert.notEqual(x.seq, y.seq);
  const d = await SCAN.pollScans({ orgId: ORG, membership: cashier, pairId: p.pairId, after: a.seq }); assert.deepEqual(d.codes.map((z) => z.code).sort(), ["A1", "B2"]);
  // another company can't read this till's codes
  assert.equal((await SCAN.pollScans({ orgId: String(other), membership: cashier, pairId: p.pairId })).status, 404);
  // ending the pairing stops the phone
  await SCAN.endScanPair({ orgId: ORG, membership: cashier, actorEmail: cashier.email, pairId: p.pairId });
  assert.equal((await SCAN.pushScan({ token: p.token, code: "C3" })).code, "PAIR_ENDED"); assert.equal((await SCAN.pairStatus({ token: p.token })).code, "PAIR_ENDED");
  assert.equal((await SCAN.pollScans({ orgId: ORG, membership: cashier, pairId: p.pairId, after: 0 })).active, false);
});

test("bad keys, bad codes and expired pairings are refused", { timeout: 120000 }, async () => {
  assert.equal((await SCAN.pushScan({ token: "short", code: "1" })).code, "PAIR_INVALID");
  assert.equal((await SCAN.pushScan({ token: "x".repeat(32), code: "1" })).code, "PAIR_ENDED", "unknown key");
  const p = await SCAN.createScanPair({ orgId: ORG, membership: cashier, actorEmail: cashier.email });
  for (const bad of ["", "x".repeat(65), "é", "<script>\u0000"]) assert.equal((await SCAN.pushScan({ token: p.token, code: bad })).code, "CODE", JSON.stringify(bad));
  assert.ok((await SCAN.pushScan({ token: p.token, code: "  SKU-9\r\n" })).ok, "scanner line endings are trimmed");
  await c.db.collection("calendar_records").updateOne({ kind: SCAN.PAIR_KIND, orgId, _id: new ObjectId(p.pairId) }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await SCAN.pushScan({ token: p.token, code: "1" })).code, "PAIR_ENDED", "12-hour limit");
});
