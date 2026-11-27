// test/powerbi.test.mjs
//
// Microsoft Power BI integration (SOW INAYA-BOS-POWERBI-SOW-2026-V1), automated acceptance (SOW 14.1 and the API side of 14.3):
// OAuth 2.0 + PKCE, token signing and expiry, refresh rotation and reuse detection, revocation, Enterprise/feature/licence
// gates, company isolation, branch, department and role restrictions, paging and windows, soft deletes, the emailed sign-in
// code, computed workforce hours, and sales lines reconciling with Inaya's own Commerce report. Real test Atlas, RUN fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../src/lib/mongodb.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { hashToken } from "../src/lib/orgs.js";
import * as O from "../src/lib/analytics/oauth.js";
import * as D from "../src/lib/analytics/datasets.js";

const RUN = randomUUID().slice(0, 8);
const orgIds = []; const emails = [];
const REDIRECT = O.REDIRECT_URIS[0];
async function db() { return (await connectToDatabase()).db; }
async function mkOrg(plan, extra = {}) {
  const _id = new ObjectId(); orgIds.push(_id);
  await (await db()).collection("orgs").insertOne({ _id, name: `PBI ${RUN} ${plan}`, plan, ownerEmail: `owner-${RUN}@pbi.test`, features: { FEATURE_POWER_BI: true, FEATURE_COMMERCE: true }, createdAt: new Date().toISOString(), ...extra });
  return _id;
}
async function mkMember(orgId, email, fields = {}) { emails.push(email); await (await db()).collection("org_members").insertOne({ orgId, email, role: "member", status: "active", departmentIds: [], createdAt: new Date().toISOString(), ...fields }); }
const req = (token) => ({ headers: new Headers(token ? { authorization: `Bearer ${token}` } : {}) });
const verifier = () => randomBytes(32).toString("base64url");
async function connect(orgId, email) {
  const v = verifier();
  const { redirect } = await O.approve({ email, orgId: String(orgId), params: { response_type: "code", client_id: O.CLIENT_ID, redirect_uri: REDIRECT, state: "s1", code_challenge: O.challengeOf(v), code_challenge_method: "S256" } });
  const code = new URL(redirect).searchParams.get("code"); assert.equal(new URL(redirect).searchParams.get("state"), "s1");
  return O.exchangeToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: v, client_id: O.CLIENT_ID });
}
async function read(token, name, query = {}) { const a = await O.requireAnalyticsToken(req(token)); return D.readDataset({ orgId: a.orgId, membership: a.membership, name, query }); }

after(async () => {
  const d = await db();
  for (const c of ["org_members", "sales_orders", "invoices", "stock_levels", "warehouses", "calendar_records", "org_activity", "employees"]) await d.collection(c).deleteMany({ orgId: { $in: orgIds } });
  await d.collection("api_keys").deleteMany({ kind: "oauth_grant", orgId: { $in: orgIds } });
  await d.collection("mfa_pending").deleteMany({ $or: [{ orgId: { $in: orgIds } }, { email: { $in: emails } }] });
  await d.collection("sessions").deleteMany({ email: { $in: emails } });
  await d.collection("orgs").deleteMany({ _id: { $in: orgIds } });
  await (await mongoClientPromise).close();
});

test("access tokens: signed, expiring, tamper-proof", () => {
  const exp = Math.floor(Date.now() / 1000) + 60; const t = O.signAccessToken({ grantId: "g1", exp });
  assert.equal(O.readAccessToken(t).g, "g1");
  assert.equal(O.readAccessToken(t.slice(0, -2) + "xx"), null);
  const [v, body, sig] = t.split("."); const forged = Buffer.from(JSON.stringify({ g: "other", exp })).toString("base64url");
  assert.equal(O.readAccessToken(`${v}.${forged}.${sig}`), null);
  assert.equal(O.readAccessToken(O.signAccessToken({ grantId: "g1", exp: Math.floor(Date.now() / 1000) - 1 })), null);
  assert.throws(() => O.validateAuthorizeParams({ response_type: "code", client_id: "evil", redirect_uri: REDIRECT, state: "x", code_challenge: "a".repeat(43), code_challenge_method: "S256" }), /Unknown client/);
  assert.throws(() => O.validateAuthorizeParams({ response_type: "code", client_id: O.CLIENT_ID, redirect_uri: "https://evil.test/cb", state: "x", code_challenge: "a".repeat(43), code_challenge_method: "S256" }), /redirect/);
  assert.throws(() => O.validateAuthorizeParams({ response_type: "code", client_id: O.CLIENT_ID, redirect_uri: REDIRECT, state: "x", code_challenge: "a".repeat(43), code_challenge_method: "plain" }), /PKCE/);
});

test("who may connect: Enterprise only, pilot switch, owners/admins unless members are allowed", async () => {
  const biz = await mkOrg("business"); await mkMember(biz, `own-biz-${RUN}@pbi.test`, { role: "owner" });
  assert.match((await O.connectEligibility(biz, `own-biz-${RUN}@pbi.test`)).reason, /Enterprise/);
  const off = await mkOrg("enterprise", { features: {} }); await mkMember(off, `own-off-${RUN}@pbi.test`, { role: "owner" });
  assert.match((await O.connectEligibility(off, `own-off-${RUN}@pbi.test`)).reason, /not switched on/);
  const ent = await mkOrg("enterprise"); await mkMember(ent, `own-${RUN}@pbi.test`, { role: "owner" }); await mkMember(ent, `mem-${RUN}@pbi.test`);
  assert.equal((await O.connectEligibility(ent, `own-${RUN}@pbi.test`)).ok, true);
  assert.match((await O.connectEligibility(ent, `mem-${RUN}@pbi.test`)).reason, /owners and admins/);
  await (await db()).collection("orgs").updateOne({ _id: ent }, { $set: { "powerBi.membersMayConnect": true } });
  assert.equal((await O.connectEligibility(ent, `mem-${RUN}@pbi.test`)).ok, true);
  assert.match((await O.connectEligibility(ent, `stranger-${RUN}@pbi.test`)).reason, /not an active member/);
});

test("OAuth: PKCE and redirect checked, code single use, refresh rotation, reuse revokes, revocation is immediate", async () => {
  const ent = await mkOrg("enterprise"); const email = `oa-${RUN}@pbi.test`; await mkMember(ent, email, { role: "owner" });
  const v = verifier(); const params = { response_type: "code", client_id: O.CLIENT_ID, redirect_uri: REDIRECT, state: "z", code_challenge: O.challengeOf(v), code_challenge_method: "S256" };
  const code = new URL((await O.approve({ email, orgId: String(ent), params })).redirect).searchParams.get("code");
  await assert.rejects(O.exchangeToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier() }), /PKCE/);
  await assert.rejects(O.exchangeToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: v }), /invalid or expired/, "a code is single use, even after a failed try");
  const t1 = await connect(ent, email);
  assert.equal(t1.token_type, "Bearer"); assert.equal(t1.expires_in, 3600);
  assert.equal((await read(t1.access_token, "branches")).dataset, "branches");
  const t2 = await O.exchangeToken({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  await assert.rejects(O.exchangeToken({ grant_type: "refresh_token", refresh_token: t1.refresh_token }), /invalid/);
  await assert.rejects(O.requireAnalyticsToken(req(t2.access_token)), /revoked/, "reusing a rotated refresh token revokes the whole connection");
  const t3 = await connect(ent, email);
  await O.revokeToken(t3.refresh_token);
  await assert.rejects(O.requireAnalyticsToken(req(t3.access_token)), /revoked/, "an unexpired access token stops working at once");
  await assert.rejects(O.requireAnalyticsToken(req(null)), /Sign in/);
  const acts = await (await db()).collection("org_activity").find({ orgId: ent, recordType: "POWER_BI" }).toArray();
  assert.ok(acts.some((a) => a.action === "POWERBI_CONNECTED") && acts.some((a) => a.action === "POWERBI_REVOKED"));
  assert.ok(!JSON.stringify(acts).includes(t3.refresh_token) && !JSON.stringify(acts).includes(t3.access_token), "no tokens in the audit trail");
});

test("isolation, branches, departments and roles are enforced on every request", async () => {
  const d = await db();
  const A = await mkOrg("enterprise", { "powerBi": { membersMayConnect: true } }); const B = await mkOrg("enterprise");
  const [lhr, khi] = [new ObjectId(), new ObjectId()]; const dept = new ObjectId(), otherDept = new ObjectId();
  await d.collection("warehouses").insertMany([{ _id: lhr, orgId: A, name: "Lahore" }, { _id: khi, orgId: A, name: "Karachi" }, { orgId: B, name: "B-only" }]);
  await d.collection("stock_levels").insertMany([{ orgId: A, productId: new ObjectId(), warehouseId: lhr, quantity: 5 }, { orgId: A, productId: new ObjectId(), warehouseId: khi, quantity: 7 }, { orgId: B, productId: new ObjectId(), warehouseId: new ObjectId(), quantity: 99 }]);
  const now = new Date().toISOString();
  await d.collection("invoices").insertMany([{ orgId: A, departmentId: dept, invoiceNumber: `A-${RUN}-1`, total: 100, currency: "PKR", status: "SENT", createdAt: now, deletedAt: null },
    { orgId: A, departmentId: otherDept, invoiceNumber: `A-${RUN}-2`, total: 50, currency: "PKR", status: "PAID", createdAt: now, deletedAt: now },
    { orgId: B, departmentId: new ObjectId(), invoiceNumber: `B-${RUN}-1`, total: 1, currency: "USD", createdAt: now, deletedAt: null }]);
  const owner = `a-own-${RUN}@pbi.test`, cashier = `a-cash-${RUN}@pbi.test`, acct = `a-acct-${RUN}@pbi.test`;
  await mkMember(A, owner, { role: "owner" }); await mkMember(A, cashier, { commerceRole: "cashier", locationIds: [String(lhr)] }); await mkMember(A, acct, { financeRole: "staff", departmentIds: [dept], locationIds: [String(lhr)] });
  await mkMember(B, owner, { role: "owner" });
  const tOwnA = await connect(A, owner); const tCash = await connect(A, cashier); const tAcct = await connect(A, acct); const tOwnB = await connect(B, owner);

  const brA = (await read(tOwnA.access_token, "branches")).rows.map((r) => r.name).sort();
  assert.deepEqual(brA, ["Karachi", "Lahore"], "company A sees only its own branches");
  assert.deepEqual((await read(tOwnB.access_token, "branches")).rows.map((r) => r.name), ["B-only"], "company B sees only B");
  assert.deepEqual((await read(tCash.access_token, "stock_balances")).rows.map((r) => r.quantity), [5], "a Lahore cashier sees Lahore stock only");
  await assert.rejects(read(tCash.access_token, "invoices"), /Finance access/, "no finance role, no invoices");
  await assert.rejects(read(tCash.access_token, "employees"), /HR access/);
  await assert.rejects(read(tCash.access_token, "sales_lines"), /supervisors/);
  const inv = (await read(tAcct.access_token, "invoices")).rows;
  assert.deepEqual(inv.map((r) => r.invoiceNumber), [`A-${RUN}-1`], "finance staff see only their departments");
  const all = (await read(tOwnA.access_token, "invoices")).rows;
  assert.equal(all.length, 2); assert.equal(all.find((r) => r.invoiceNumber === `A-${RUN}-2`).isDeleted, true, "soft-deleted rows are flagged, not hidden");
  assert.ok(!all.some((r) => r.invoiceNumber.startsWith("B-")));

  // the person loses their role / leaves: the very next request fails, without waiting for the token to expire
  await d.collection("org_members").updateOne({ orgId: A, email: acct }, { $set: { financeRole: null } });
  await assert.rejects(read(tAcct.access_token, "invoices"), /Finance access/);
  await d.collection("org_members").updateOne({ orgId: A, email: acct }, { $set: { status: "removed" } });
  await assert.rejects(O.requireAnalyticsToken(req(tAcct.access_token)), /not an active member/);
  // the company drops below Enterprise, or the pilot switch is turned off
  await d.collection("orgs").updateOne({ _id: B }, { $set: { plan: "business" } });
  await assert.rejects(O.requireAnalyticsToken(req(tOwnB.access_token)), /Enterprise/);
  await assert.rejects(O.exchangeToken({ grant_type: "refresh_token", refresh_token: tOwnB.refresh_token }), /Enterprise/);
});

test("paging, windows and stable ids: no row twice, nothing skipped", async () => {
  const d = await db(); const A = await mkOrg("enterprise"); const owner = `pg-${RUN}@pbi.test`; await mkMember(A, owner, { role: "owner" });
  const base = Date.now() - 5 * 86400000;
  await d.collection("invoices").insertMany(Array.from({ length: 23 }, (_, i) => ({ orgId: A, invoiceNumber: `P-${i}`, total: i, currency: "PKR", createdAt: new Date(base + (i % 4) * 3600000).toISOString(), deletedAt: null })));
  const t = await connect(A, owner); const seen = [];
  let cursor = null; do { const p = await read(t.access_token, "invoices", { limit: 5, ...(cursor ? { cursor } : {}) }); seen.push(...p.rows.map((r) => r.id)); cursor = p.next; } while (cursor);
  assert.equal(seen.length, 23); assert.equal(new Set(seen).size, 23);
  assert.equal((await read(t.access_token, "invoices", { from: new Date(Date.now() - 86400000).toISOString() })).rowCount, 0, "outside the window");
  await assert.rejects(read(t.access_token, "invoices", { from: "2020-01-01", to: "2026-01-01" }), /at most 366 days/);
  await assert.rejects(read(t.access_token, "invoices", { from: "not a date" }), /must be dates/);
  await assert.rejects(read(t.access_token, "invoices", { cursor: "%%%" }), /cursor/);
  await assert.rejects(read(t.access_token, "nope"), /Unknown dataset/);
  const cat = D.catalogue({ role: "member" }); assert.equal(cat.find((x) => x.name === "invoices").allowed, false);
  assert.ok(cat.every((x) => x.fields.every((f) => f.name && f.type && f.description)), "every field documented");
});

test("POS sales lines reconcile with Inaya's own Commerce report", async () => {
  const d = await db(); const A = await mkOrg("enterprise"); const owner = `rc-${RUN}@pbi.test`; await mkMember(A, owner, { role: "owner" });
  const wh = new ObjectId(); await d.collection("warehouses").insertOne({ _id: wh, orgId: A, name: "Main" });
  const at = new Date(Date.now() - 2 * 3600000).toISOString(); const p1 = new ObjectId(), p2 = new ObjectId();
  const line = (productId, sku, qty, netMinor, taxMinor, disc) => ({ productId, sku, name: sku, quantity: qty, netMinor, taxMinor, grossMinor: netMinor + taxMinor, lineDiscountMinor: disc, orderShareMinor: 0, unitCost: 1 });
  await d.collection("sales_orders").insertMany([
    { orgId: A, channel: "POS", status: "COMPLETED", warehouseId: wh, saleNumber: "S-1", currency: "PKR", completedAt: at, createdAt: at, lines: [line(p1, "A", 2, 10000, 1700, 500), line(p2, "B", 1, 4000, 680, 0)], tenders: [], refunds: [] },
    { orgId: A, channel: "POS", status: "COMPLETED", warehouseId: wh, saleNumber: "S-2", currency: "PKR", completedAt: at, createdAt: at, lines: [line(p1, "A", 1, 5000, 850, 0)], tenders: [], refunds: [] },
  ]);
  const t = await connect(A, owner);
  const rows = (await read(t.access_token, "sales_lines")).rows;
  const sum = (k) => Math.round(rows.filter((r) => !r.isVoided).reduce((n, r) => n + r[k], 0) * 100) / 100;
  const { commerceReport } = await import("../src/lib/commerce/reports.js");
  const rep = await commerceReport({ orgId: String(A), membership: { role: "owner", email: owner }, input: { from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() } });
  assert.ok(!rep.error, JSON.stringify(rep).slice(0, 200));
  const tot = rep.totals || rep.summary || rep;
  const pick = (...ks) => { for (const k of ks) if (tot[k] !== undefined) return Number(tot[k]); return null; };
  assert.equal(sum("netSales"), pick("netSales", "net")); assert.equal(sum("grossSales"), pick("grossSales", "gross")); assert.equal(sum("tax"), pick("tax", "taxCollected"));
  assert.equal(sum("netSales"), 190); assert.equal(sum("discounts"), 5);
});

test("emailed sign-in code: right code signs in once; five wrong tries lock it", async () => {
  const A = await mkOrg("enterprise"); const email = `ec-${RUN}@pbi.test`; await mkMember(A, email, { role: "owner" });
  assert.deepEqual(await O.sendEmailCode(email), { sent: true });
  assert.deepEqual(await O.sendEmailCode(`nobody-${RUN}@pbi.test`), { sent: true }, "the same answer for unknown emails");
  const d = await db(); await d.collection("mfa_pending").updateOne({ purpose: "pbi-email-code", email }, { $set: { tokenHash: hashToken(`${email}:123456`) } });
  await assert.rejects(O.verifyEmailCode(email, "000000"), /not right/);
  const ok = await O.verifyEmailCode(email, "123456"); assert.equal(ok.email, email); assert.ok(ok.sessionToken);
  await assert.rejects(O.verifyEmailCode(email, "123456"), /expired/, "single use");
  await O.sendEmailCode(email); await d.collection("mfa_pending").updateOne({ purpose: "pbi-email-code", email }, { $set: { tokenHash: hashToken(`${email}:654321`) } });
  for (let i = 0; i < 5; i++) await assert.rejects(O.verifyEmailCode(email, "111111"), /not right/);
  await assert.rejects(O.verifyEmailCode(email, "654321"), /expired/, "locked after five wrong tries");
});

test("workforce hours per person per day come from the timesheet calculation", async () => {
  const d = await db(); const A = await mkOrg("enterprise"); const owner = `wf-${RUN}@pbi.test`; await mkMember(A, owner, { role: "owner" });
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10); const p = (type, h, m = 0) => ({ orgId: A, kind: "w_punch", email: `sara-${RUN}@pbi.test`, type, idem: `${RUN}-${type}-${h}-${m}`, at: `${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`, createdAt: new Date().toISOString() });
  await d.collection("calendar_records").insertMany([p("CLOCK_IN", 9), p("BREAK_START", 12), p("BREAK_END", 12, 30), p("CLOCK_OUT", 17)]);
  const t = await connect(A, owner);
  const rows = (await read(t.access_token, "workforce_hours", { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` })).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].workedHours, 7.5); assert.equal(rows[0].breakHours, 0.5);
});
