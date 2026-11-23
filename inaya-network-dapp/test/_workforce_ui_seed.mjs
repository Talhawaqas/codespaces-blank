// Seeds a throwaway 2-branch company on the TEST database for the Time & Rota browser check; prints owner + cashier sessions.
// Run: $env:INAYA_USE_TEST_DB="1"; node --env-file=.env.local --import ./test/_next-loader.mjs test/_workforce_ui_seed.mjs [cleanup <orgId>]
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { ObjectId } from "mongodb";
import * as SC from "../src/lib/workforce/scope.js";
import * as T from "../src/lib/workforce/time.js";
if (process.env.INAYA_USE_TEST_DB !== "1") throw new Error("TEST database only");
await ensureOrgIndexes();
const c = await getOrgCollections();
if (process.argv[2] === "cleanup") {
  const orgId = new ObjectId(process.argv[3]);
  for (const n of ["warehouses", "calendar_records", "org_activity", "departments", "org_members"]) await c.db.collection(n).deleteMany({ orgId });
  await c.orgs.deleteMany({ _id: orgId }); console.log("cleaned", String(orgId)); process.exit(0);
}
const now = new Date().toISOString(); const run = Date.now().toString(36);
const owner = { role: "owner", email: `wf-owner-${run}@example.com` }; const cashier = `wf-cashier-${run}@example.com`; const mgr = `wf-manager-${run}@example.com`;
const orgId = new ObjectId(); const ORG = String(orgId);
await c.orgs.insertOne({ _id: orgId, name: `Two Branch Mart ${run}`, ownerEmail: owner.email, plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now });
const dep = (await c.departments.insertOne({ orgId, name: "Shops", createdAt: now })).insertedId;
const lhr = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Lahore branch", city: "Lahore", createdAt: now })).insertedId;
await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Karachi branch", city: "Karachi", createdAt: now });
await c.orgMembers.insertMany([
  { orgId, email: owner.email, role: "owner", status: "active", departmentIds: [dep], createdAt: now },
  { orgId, email: cashier, role: "member", status: "active", departmentIds: [dep], createdAt: now },
  { orgId, email: mgr, role: "member", status: "active", departmentIds: [dep], createdAt: now },
]);
await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: cashier, input: { template: "cashier", locationIds: [String(lhr)] } });
await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: mgr, input: { template: "store_manager", locationIds: [String(lhr)] } });
const m = await c.orgMembers.findOne({ orgId, email: mgr });
const d = new Date(); d.setUTCHours(9, 0, 0, 0);
await T.saveShift({ orgId: ORG, membership: m, actorEmail: mgr, input: { email: cashier, locationId: String(lhr), start: d.toISOString(), end: new Date(d.getTime() + 8 * 3600000).toISOString(), role: "Till" } });
console.log(JSON.stringify({ orgId: ORG, cookieName: SESSION_COOKIE, owner: (await createSession(owner.email)).sessionToken, cashier: (await createSession(cashier)).sessionToken }));
process.exit(0);
