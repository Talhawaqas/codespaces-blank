// test/hospitality.test.mjs
//
// Hospitality & Food Service Workspace SOW. Part 1 is pure rules (state machine, slots, time zones and DST, table
// picking, units, recipes, wastage, counts, permissions, reports). Part 2 runs end to end against the real database
// in a throwaway company: location -> seating -> bookings (incl. a simultaneous double-booking attempt and capacity)
// -> lifecycle -> CRM link -> waitlist -> public page (idempotency, honeypot, token) -> menu and recipes -> wastage
// approval -> stock count -> reorder through the existing purchase-request flow -> delivery discrepancy -> roster ->
// checklists -> incidents -> reports -> AI tools -> audit entries; plus cross-company, cross-location and role tests.
// No real email is sent (RESEND_API_KEY is removed for the run). Everything created is removed by orgId at the end.
//
// Run with: node --env-file=.env.local --test-force-exit --test test/hospitality.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ObjectId } from "mongodb";

const realResendKey = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;

const { connectToDatabase } = await import("../src/lib/mongodb.js");
const S = await import("../src/lib/hospitality/store.js");
const L = await import("../src/lib/hospitality/locations.js");
const R = await import("../src/lib/hospitality/reservations.js");
const M = await import("../src/lib/hospitality/menu.js");
const K = await import("../src/lib/hospitality/stock.js");
const O = await import("../src/lib/hospitality/operations.js");
const P = await import("../src/lib/hospitality/reports.js");
const G = await import("../src/lib/engagement/segments.js");
const { zonedToUtc, zonedDateKey, addDaysKey } = await import("../src/lib/engagement/time.js");
const { db } = await connectToDatabase();

// ======================= Part 1: pure rules =======================
test("reservation lifecycle: only the documented transitions are allowed", () => {
  assert.ok(R.canTransition("REQUESTED", "CONFIRMED"));
  assert.ok(R.canTransition("CONFIRMED", "SEATED"));
  assert.ok(R.canTransition("SEATED", "COMPLETED"));
  for (const [a, b] of [["COMPLETED", "CONFIRMED"], ["CANCELLED", "CONFIRMED"], ["NO_SHOW", "SEATED"], ["SEATED", "CANCELLED"], ["REQUESTED", "SEATED"], ["CONFIRMED", "COMPLETED"], ["DECLINED", "REQUESTED"]]) assert.equal(R.canTransition(a, b), false, `${a} -> ${b} must be refused`);
  for (const s of R.STATUSES) assert.ok(Array.isArray(R.TRANSITIONS[s]), `${s} has a transition list`);
});

test("slot buckets: a 90-minute booking holds six 15-minute slots, back-to-back bookings share none", () => {
  const a = R.buckets("2026-12-01T18:00:00Z", "2026-12-01T19:30:00Z"), b = R.buckets("2026-12-01T19:30:00Z", "2026-12-01T21:00:00Z");
  assert.equal(a.length, 6);
  assert.equal(a.filter((x) => b.includes(x)).length, 0);
  assert.equal(R.buckets("2026-12-01T19:00:00Z", "2026-12-01T20:00:00Z").filter((x) => a.includes(x)).length, 2);
});

const hours = (p) => Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, p]));
const loc = (over = {}) => ({ timeZone: "Asia/Karachi", hours: hours([{ from: "12:00", to: "15:00" }, { from: "18:00", to: "23:00" }]), closures: [], policy: { ...L.DEFAULT_POLICY, leadMinutes: 0 }, ...over });

test("candidate slots: service periods, last seating, lead time, horizon, closures", () => {
  const now = new Date("2026-12-01T03:00:00Z"); // 08:00 in Karachi
  const s = R.candidateSlots(loc(), "2026-12-01", now).map((x) => x.time);
  assert.equal(s[0], "12:00");
  assert.ok(s.includes("14:00") && !s.includes("14:15"), "last seating is an hour before the period closes");
  assert.ok(!s.includes("15:00") && !s.includes("16:00"), "nothing between service periods");
  assert.equal(s[s.length - 1], "22:00");
  assert.deepEqual(R.candidateSlots(loc({ closures: [{ date: "2026-12-01" }] }), "2026-12-01", now), []);
  assert.deepEqual(R.candidateSlots(loc(), "2026-11-30", now), [], "a past date has no slots");
  assert.deepEqual(R.candidateSlots(loc(), addDaysKey("2026-12-01", 61), now), [], "beyond the booking horizon");
  const late = R.candidateSlots(loc({ policy: { ...L.DEFAULT_POLICY, leadMinutes: 120 } }), "2026-12-01", new Date("2026-12-01T12:30:00Z")).map((x) => x.time); // 17:30 local
  assert.equal(late[0], "19:30", "minimum notice removes times that are too soon");
  assert.deepEqual(R.candidateSlots(loc(), "not-a-date", now), []);
});

test("time zones and daylight saving: slots are real instants in the location's zone", () => {
  // New York springs forward on 2027-03-14: 02:00-03:00 doesn't exist, and the day's offset changes.
  const ny = loc({ timeZone: "America/New_York", hours: hours([{ from: "01:00", to: "05:00" }]) });
  const slots = R.candidateSlots(ny, "2027-03-14", new Date("2027-03-13T00:00:00Z"));
  assert.ok(!slots.some((s) => s.time.startsWith("02:")), "times skipped by the clock change are not offered");
  const one = slots.find((s) => s.time === "01:00"), three = slots.find((s) => s.time === "03:00");
  assert.equal(three.start - one.start, 3600000, "01:00 and 03:00 are one real hour apart that night");
  assert.equal(zonedDateKey(zonedToUtc("2026-12-31", "23:30", "Asia/Karachi"), "Asia/Karachi"), "2026-12-31");
  assert.equal(zonedToUtc("2026-12-31", "23:30", "Asia/Karachi").toISOString(), "2026-12-31T18:30:00.000Z");
});

test("hours and policy validation", () => {
  assert.ok(L.normalizeHours({ mon: [{ from: "12:00", to: "15:00" }] }).hours);
  assert.match(L.normalizeHours({ mon: [{ from: "12:10", to: "15:00" }] }).error, /quarter hour/);
  assert.match(L.normalizeHours({ mon: [{ from: "18:00", to: "02:00" }] }).error, /after it starts/);
  assert.match(L.normalizeHours({ mon: [{ from: "12:00", to: "15:00" }, { from: "14:00", to: "16:00" }] }).error, /overlap/);
  assert.equal(L.normalizePolicy({}).policy.slotMinutes, 15);
  assert.ok(L.normalizePolicy({ slotMinutes: 20 }).error);
  assert.ok(L.normalizePolicy({ turnTimes: [{ maxParty: 2, minutes: 50 }] }).error, "turn times must be in quarter hours");
  assert.equal(L.turnMinutes(L.DEFAULT_POLICY, 2), 90);
  assert.equal(L.turnMinutes(L.DEFAULT_POLICY, 5), 120);
  assert.equal(L.turnMinutes(L.DEFAULT_POLICY, 40), 150);
  assert.ok(L.normalizeTable({ label: "T1", minParty: 2, maxParty: 4 }).table);
  assert.ok(L.normalizeTable({ label: "T1", minParty: 5, maxParty: 4 }).error);
});

const T = (id, min, max, area = "a", combo = []) => ({ _id: id, label: id, minParty: min, maxParty: max, areaId: area, combinableWith: combo, active: true });
test("table picking: smallest fit first, preferred area, combinable pairs, blocked tables", () => {
  const free = [T("t6", 4, 6), T("t2", 1, 2), T("t4", 2, 4, "b"), T("c1", 2, 4, "a", ["c2"]), T("c2", 2, 4, "a", ["c1"])];
  assert.equal(R.pickTables(free, 2)[0]._id, "t2");
  assert.equal(R.pickTables(free, 3)[0].maxParty, 4);
  assert.equal(R.pickTables(free, 3, "b")[0]._id, "t4", "the preferred area wins among tables that fit");
  assert.deepEqual(R.pickTables(free, 8).map((t) => t._id).sort(), ["c1", "c2"], "a large party gets a combinable pair");
  assert.deepEqual(R.pickTables(free, 20), []);
  assert.equal(R.tablesCombinable([free[3], free[4]]), true);
  assert.equal(R.tablesCombinable([free[0], free[1]]), false);
  const blocked = { ...T("b", 1, 4), blocks: [{ from: "2026-12-01T18:00:00Z", to: "2026-12-01T20:00:00Z" }] };
  assert.equal(R.tableUnavailable(blocked, "2026-12-01T19:00:00Z", "2026-12-01T20:30:00Z"), true);
  assert.equal(R.tableUnavailable(blocked, "2026-12-01T20:00:00Z", "2026-12-01T21:00:00Z"), false);
  assert.equal(R.tableUnavailable({ ...T("x", 1, 4), active: false }, 0, 1), true);
  assert.equal(R.tableUnavailable(T("x", 1, 4, "closed"), 0, 1, new Set(["closed"])), true);
  assert.equal(R.nextSuitableParty([{ partySize: 9 }, { partySize: 2 }], [T("t2", 1, 2)]).partySize, 2, "the oldest party that fits is next");
});

test("permissions: each role holds only what it needs; location scope is explicit with several locations", () => {
  const m = (r, extra = {}) => ({ email: `${r}@x.test`, role: "member", hospitalityRole: r, ...extra });
  const owner = { role: "owner" };
  assert.equal(S.canAccessHospitality({ role: "member" }), false, "a member with no hospitality role has no access");
  assert.equal(S.canAccessHospitality({ role: "member", hospitalityRole: "made-up" }), false);
  assert.ok(Object.values(S.capabilitiesOf(owner)).every(Boolean));
  const svc = S.capabilitiesOf(m("service")), host = S.capabilitiesOf(m("host")), kit = S.capabilitiesOf(m("kitchen")), stk = S.capabilitiesOf(m("stock")), mgr = S.capabilitiesOf(m("manager"));
  assert.ok(svc.reservationsRead && svc.serviceUpdate && !svc.reservationsWrite && !svc.guestNotes && !svc.stockRead && !svc.reports);
  assert.ok(host.reservationsWrite && host.guestNotes && !host.guestExport && !host.menuEdit && !host.stockWrite && !host.rosterEdit);
  assert.ok(kit.menuEdit && !kit.menuPublish && kit.stockWrite && !kit.stockApprove && !kit.reservationsRead && !kit.reorder);
  assert.ok(stk.reorder && stk.stockWrite && !stk.stockApprove && !stk.menuEdit && !stk.reservationsRead);
  assert.ok(mgr.manage && mgr.reports && mgr.stockApprove && mgr.guestExport && !mgr.integrations, "integrations stay with the owner/admin");
  assert.equal(S.memberCanUseLocation(m("host"), "L1", 1), true, "one location: no list needed");
  assert.equal(S.memberCanUseLocation(m("host"), "L1", 2), false, "several locations: access must be explicit");
  assert.equal(S.memberCanUseLocation(m("host", { hospitalityLocationIds: ["L2"] }), "L1", 2), false);
  assert.equal(S.memberCanUseLocation(m("host", { hospitalityLocationIds: ["L2"] }), "L2", 2), true);
  assert.equal(S.memberCanUseLocation(owner, "L9", 5), true);
  const r = { _id: "1", guest: { name: "A", email: "a@b.c", phone: "1" }, internalNote: "vip", tableIds: [], partySize: 2 };
  assert.equal(R.reservationView(r, m("service")).guest.email, undefined, "service staff never get contact details");
  assert.equal(R.reservationView(r, m("service")).internalNote, undefined, "or private staff notes");
  assert.equal(R.reservationView(r, m("host")).internalNote, "vip");
  assert.equal(O.canSeeIncident(m("service"), { reportedByEmail: "other@x.test" }, "service@x.test"), false);
  assert.equal(O.canSeeIncident(m("service"), { reportedByEmail: "service@x.test" }, "service@x.test"), true);
  assert.equal(O.canSeeIncident(m("manager"), { reportedByEmail: "other@x.test" }, "manager@x.test"), true);
});

test("menu rules: unit conversion, modifiers, availability, recipes and cost coverage", () => {
  assert.equal(M.convertQuantity(500, "g", "kg"), 0.5);
  assert.equal(M.convertQuantity(2, "l", "ml"), 2000);
  assert.equal(M.convertQuantity(3, "piece", "piece"), 3);
  assert.equal(M.convertQuantity(1, "g", "ml"), null, "weight can't be converted to volume");
  assert.equal(M.convertQuantity(1, "bunch", "kg"), null);
  assert.ok(M.normalizeModifiers([{ name: "Size", required: true, options: [{ name: "Large", priceDeltaMinor: 200 }] }]).modifiers);
  assert.ok(M.normalizeModifiers([{ name: "Size", options: [] }]).error);
  assert.ok(M.normalizeModifiers([{ name: "Size", options: [{ name: "L", priceDeltaMinor: 1.5 }] }]).error);
  assert.equal(M.normalizeAvailability(null).availability, null);
  assert.ok(M.normalizeAvailability({ from: "15:00", to: "11:00" }).error);
  const products = new Map([["p1", { _id: "p1", name: "Flour", unit: "kg" }], ["p2", { _id: "p2", name: "Milk", unit: "l" }]]);
  const rec = M.normalizeRecipe({ yieldServings: 4, ingredients: [{ productId: "p1", quantity: 500, unit: "g" }, { productId: "p2", quantity: 250, unit: "ml" }] }, products).recipe;
  assert.equal(rec.ingredients[0].stockQuantity, 0.5);
  assert.equal(rec.ingredients[1].stockQuantity, 0.25);
  assert.match(M.normalizeRecipe({ ingredients: [{ productId: "p1", quantity: 1, unit: "ml" }] }, products).error, /can't be converted/);
  assert.match(M.normalizeRecipe({ ingredients: [{ productId: "zz", quantity: 1 }] }, products).error, /wasn't found/);
  assert.match(M.normalizeRecipe({ ingredients: [{ productId: "p1", quantity: 1 }, { productId: "p1", quantity: 2 }] }, products).error, /twice/);
  const full = M.recipeCost(rec, new Map([["p1", { cost: 100 }], ["p2", { cost: 200 }]]));
  assert.equal(full.status, "estimate");
  assert.equal(full.costPerServing, (100 * 0.5 + 200 * 0.25) / 4);
  const part = M.recipeCost(rec, new Map([["p1", { cost: 100 }]]));
  assert.equal(part.status, "insufficient_data", "a partly-costed recipe never shows a cost");
  assert.equal(part.costPerServing, undefined);
  assert.equal(M.recipeCost(null, new Map()).status, "no_recipe");
});

test("stock rules: wastage approval threshold and count variance", () => {
  assert.equal(K.wastageNeedsApproval(5, { wastageApprovalQuantity: null }), false);
  assert.equal(K.wastageNeedsApproval(4.9, { wastageApprovalQuantity: 5 }), false);
  assert.equal(K.wastageNeedsApproval(5, { wastageApprovalQuantity: 5 }), true);
  const v = K.countVariance([{ system: 100, counted: 95 }, { system: 10, counted: 10 }, { system: 0, counted: 3 }], 10);
  assert.equal(v.changed, 2);
  assert.equal(v.lines[0].variancePercent, 5);
  assert.equal(v.needsApproval, true, "stock appearing from zero is a 100% variance");
  assert.equal(K.countVariance([{ system: 100, counted: 95 }], 10).needsApproval, false);
});

test("operations rules: shift overlap, checklist items, overdue items", () => {
  const a = { email: "A@x.test", start: "2026-12-01T10:00:00Z", end: "2026-12-01T18:00:00Z" };
  assert.equal(O.shiftsOverlap(a, { email: "a@x.test", start: "2026-12-01T17:00:00Z", end: "2026-12-01T23:00:00Z" }), true);
  assert.equal(O.shiftsOverlap(a, { email: "a@x.test", start: "2026-12-01T18:00:00Z", end: "2026-12-01T23:00:00Z" }), false);
  assert.equal(O.shiftsOverlap(a, { email: "b@x.test", start: "2026-12-01T10:00:00Z", end: "2026-12-01T18:00:00Z" }), false);
  assert.equal(O.normalizeChecklistItems(["Unlock", { label: "Fridge", dueTime: "09:00", requiresEvidence: true }]).items[1].requiresEvidence, true);
  assert.ok(O.normalizeChecklistItems([]).error);
  assert.ok(O.normalizeChecklistItems([{ label: "x", dueTime: "9am" }]).error);
  const run = { items: [{ done: false, dueAt: "2026-12-01T09:00:00Z" }, { done: true, dueAt: "2026-12-01T09:00:00Z" }, { done: false, dueAt: null }] };
  assert.equal(O.overdueItems(run, new Date("2026-12-01T10:00:00Z")).length, 1);
  assert.equal(O.overdueItems(run, new Date("2026-12-01T08:00:00Z")).length, 0);
});

test("reports: rates say 'insufficient data' instead of zero; CSV neutralises formulas", () => {
  assert.equal(P.rate(0, 0).status, "insufficient_data");
  assert.equal(P.rate(1, 3).status, "insufficient_data");
  assert.deepEqual(P.rate(2, 10), { status: "ok", value: 20, numerator: 2, denominator: 10 });
  const csv = P.reportsCsv({ reservations: { byStatus: { COMPLETED: 3 }, covers: 9 }, noShowRate: P.rate(0, 0), cancellationRate: P.rate(1, 10), repeatGuests: P.rate(0, 0), waitlistConversion: P.rate(0, 0), sourceMix: { status: "insufficient_data" }, wastage: { status: "ok", byIngredient: [{ name: "=HYPERLINK(\"http://evil\")", quantity: 2, unit: "kg" }] }, incidents: { status: "insufficient_data" } });
  assert.ok(csv.includes("'=HYPERLINK"), "a cell starting with = is prefixed so a spreadsheet won't run it");
  assert.ok(csv.includes("insufficient data"));
  for (const k of ["noShowRate", "cancellationRate", "covers", "wastage", "purchaseSpend"]) assert.ok(P.METRIC_DEFINITIONS[k], `${k} is defined`);
});

test("campaign segments: guest-visit rules validate and describe themselves", () => {
  assert.deepEqual(G.normalizeRules({ guestVisit: "not_visited_recently", consentedOnly: true }).rules, { guestVisit: "not_visited_recently", visitDays: 60, consentedOnly: true });
  assert.ok(G.normalizeRules({ guestVisit: "sometimes" }).error);
  assert.ok(G.normalizeRules({ guestVisit: "visited_recently", visitDays: 0 }).error);
  assert.match(G.describeRules({ guestVisit: "not_visited_recently", visitDays: 90, consentedOnly: true }), /not in the last 90 days.*opted in/);
});

test("wiring: the hospitality route locks every path to the hospitality industry and takes identity from the session", () => {
  const src = fs.readFileSync("src/app/api/orgs/hospitality/[[...path]]/route.js", "utf8");
  const handle = src.slice(src.indexOf("async function handle("));
  const membershipAt = handle.search(/requireMembership\(\s*req\s*,\s*orgId\s*\)/), verticalAt = handle.search(/requireVertical\(\s*orgId\s*,\s*["']hospitality["']\s*\)/), roleAt = handle.indexOf("S.canAccessHospitality(membership)"), firstDispatchAt = handle.search(/if \(a === /);
  assert.ok(membershipAt > 0 && verticalAt > membershipAt && roleAt > verticalAt && firstDispatchAt > roleAt, "membership, then the industry lock, then the role check, all before any path is dispatched");
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) assert.match(src, new RegExp(`export async function ${m}\\(req, ctx\\) \\{ return handle\\(req, ctx\\); \\}`));
  assert.doesNotMatch(src, /\.\.\.base,\s*\.\.\.(body|input)/, "the request body is spread BEFORE base so it can't override membership or actorEmail");
  assert.match(src, /const \{ orgId: _o, membership: _m, actorEmail: _a, \.\.\.input \} = body;/);
  for (const f of ["src/app/api/reserve/[slug]/route.js", "src/app/api/reserve/manage/[token]/route.js"]) {
    const pub = fs.readFileSync(f, "utf8");
    assert.match(pub, /checkRateLimit/, `${f} is rate limited`);
    assert.doesNotMatch(pub, /requireMembership|hospitality\/(stock|menu|operations|reports)/, `${f} reaches only the reservation functions`);
  }
  const tools = fs.readFileSync("src/lib/ai-hospitality-tools.js", "utf8");
  assert.doesNotMatch(tools, /createReservation|transitionReservation|updateReservation|recordWastage|draftReorder|saveItem|sendEmail|launchCampaign|applyStockCount/, "the assistant's hospitality tools are read-only");
});

// ======================= Part 2: end to end on the real database =======================
const orgId = new ObjectId(), otherOrgId = new ObjectId(), deptId = new ObjectId(), whId = new ObjectId(), supplierId = new ObjectId(), flourId = new ObjectId(), milkId = new ObjectId(), poId = new ObjectId();
const O1 = String(orgId), tag = O1.slice(-6);
const mk = (name, extra = {}) => ({ orgId, email: `${name}-${tag}@test.invalid`, name, role: "member", status: "active", departmentIds: [deptId], ...extra });
const owner = mk("owner", { role: "owner" }), manager = mk("manager", { hospitalityRole: "manager" }), host = mk("host", { hospitalityRole: "host" }), service = mk("service", { hospitalityRole: "service" }), kitchen = mk("kitchen", { hospitalityRole: "kitchen" }), stock = mk("stock", { hospitalityRole: "stock" }), outsider = mk("outsider");
const stranger = { orgId: otherOrgId, email: `stranger-${tag}@test.invalid`, role: "owner", status: "active" };
const as = (m) => ({ orgId: O1, membership: m, actorEmail: m.email });
const ctx = {};
const now = new Date();
const TZ = "Asia/Karachi";
const day = addDaysKey(zonedDateKey(now, TZ), 3);
const nowIso = () => new Date().toISOString();

test.before(async () => {
  await db.collection("orgs").insertMany([{ _id: orgId, name: `Hospitality Test ${tag}`, vertical: "hospitality", createdAt: nowIso() }, { _id: otherOrgId, name: `Other ${tag}`, vertical: "hospitality", createdAt: nowIso() }]);
  await db.collection("departments").insertOne({ _id: deptId, orgId, name: "Restaurant", createdAt: nowIso() });
  await db.collection("org_members").insertMany([owner, manager, host, service, kitchen, stock, outsider, stranger].map((m) => ({ ...m })));
  await db.collection("warehouses").insertOne({ _id: whId, orgId, departmentId: deptId, name: "Kitchen store", createdAt: nowIso(), deletedAt: null });
  await db.collection("suppliers").insertOne({ _id: supplierId, orgId, departmentId: deptId, name: "Fresh Foods", status: "ACTIVE", createdAt: nowIso(), deletedAt: null });
  await db.collection("products").insertMany([
    { _id: flourId, orgId, departmentId: deptId, sku: `FL-${tag}`, name: "Flour", unit: "kg", reorderThreshold: 20, status: "ACTIVE", createdAt: nowIso(), deletedAt: null },
    { _id: milkId, orgId, departmentId: deptId, sku: `MK-${tag}`, name: "Milk", unit: "l", reorderThreshold: 5, status: "ACTIVE", createdAt: nowIso(), deletedAt: null },
  ]);
  await db.collection("stock_levels").insertMany([{ orgId, productId: flourId, warehouseId: whId, quantity: 50 }, { orgId, productId: milkId, warehouseId: whId, quantity: 30 }]);
  await db.collection("purchase_orders").insertOne({ _id: poId, orgId, departmentId: deptId, supplierId, status: "SENT", currency: "PKR", items: [{ description: "Flour 25kg bag", productId: flourId, quantity: 4, unitPrice: 2500, unitsPerPurchaseUnit: 25, receivedQuantity: 0 }], createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null });
  await db.collection("employees").insertOne({ orgId, departmentId: deptId, memberEmail: service.email, fullName: "Service Person", jobTitle: "Server", employmentStatus: "ACTIVE", createdAt: nowIso(), deletedAt: null });
});

test.after(async () => {
  const orgs = { $in: [orgId, otherOrgId] }, both = { $in: [orgId, otherOrgId, String(orgId), String(otherOrgId)] };
  for (const c of ["calendar_records", "marketing_records", "crm_contacts", "crm_activities", "org_activity", "audit_chain_entries", "audit_chain_heads", "products", "warehouses", "stock_levels", "stock_movements", "stock_lots", "purchase_requests", "purchase_orders", "suppliers", "employees", "leave_requests", "org_members", "departments"]) await db.collection(c).deleteMany({ orgId: orgs });
  await db.collection("notifications").deleteMany({ orgId: both });
  await db.collection("orgs").deleteMany({ _id: orgs });
  if (realResendKey) process.env.RESEND_API_KEY = realResendKey;
});

test("locations: a manager creates one; other roles and other companies can't", async () => {
  const body = { name: "Main Street", timeZone: TZ, currency: "PKR", hours: hours([{ from: "12:00", to: "23:00" }]), policy: { leadMinutes: 0, maxCoversPerSlot: 12, confirmAbovePartySize: 6 }, address: "1 Main St", phone: "+92 21 111" };
  assert.equal((await L.createLocation({ ...as(host), ...body })).status, 403);
  assert.equal((await L.createLocation({ ...as(outsider), ...body })).status, 403);
  assert.match((await L.createLocation({ ...as(manager), ...body, timeZone: "Mars/Olympus" })).error, /time zone/);
  assert.match((await L.createLocation({ ...as(manager), ...body, currency: "rupees" })).error, /currency/);
  const r = await L.createLocation({ ...as(manager), ...body });
  assert.ok(r.location.id, r.error);
  ctx.loc = r.location.id;
  assert.equal(r.location.policy.maxCoversPerSlot, 12);
  const linked = await L.updateLocation({ ...as(manager), locationId: ctx.loc, warehouseId: String(whId), publicSlug: `hosp-${tag}`, onlineBooking: true });
  assert.equal(linked.location.onlineBooking, true, linked.error);
  assert.match((await L.updateLocation({ ...as(manager), locationId: ctx.loc, publicSlug: "manage" })).error, /reserved/);
  assert.equal((await L.updateLocation({ ...as(manager), locationId: ctx.loc, warehouseId: String(new ObjectId()) })).status, 404, "a stock location from nowhere is refused");
  // another company can't see or touch it, even with the id
  assert.equal((await L.updateLocation({ orgId: String(otherOrgId), membership: stranger, actorEmail: stranger.email, locationId: ctx.loc, name: "Hijacked" })).status, 404);
  assert.equal((await L.listLocations(String(otherOrgId), stranger)).locations.length, 0);
});

test("seating: areas, tables, combinable tables", async () => {
  assert.equal((await L.saveArea({ ...as(host), locationId: ctx.loc, name: "Indoor" })).status, 403);
  ctx.area = (await L.saveArea({ ...as(manager), locationId: ctx.loc, name: "Indoor" })).area.id;
  ctx.patio = (await L.saveArea({ ...as(manager), locationId: ctx.loc, name: "Patio" })).area.id;
  const t = async (label, min, max, extra = {}) => { const r = await L.saveTable({ ...as(manager), locationId: ctx.loc, areaId: ctx.area, label, minParty: min, maxParty: max, ...extra }); assert.ok(r.table, r.error); return r.table.id; };
  ctx.t1 = await t("1", 1, 2); ctx.t2 = await t("2", 2, 4); ctx.t3 = await t("3", 2, 4);
  ctx.t4 = await t("4", 2, 4, { combinableWith: [ctx.t3] });
  assert.equal((await L.saveTable({ ...as(manager), locationId: ctx.loc, areaId: ctx.area, label: "1", minParty: 1, maxParty: 2 })).status, 409, "table names are unique per location");
  const s = await L.getSeating({ ...as(service), locationId: ctx.loc });
  assert.equal(s.tables.length, 4);
  assert.ok(s.tables.find((x) => x.id === ctx.t3).combinableWith.includes(ctx.t4), "combining is mutual");
  assert.equal((await L.getSeating({ ...as(kitchen), locationId: ctx.loc })).status, 403);
});

test("booking: confirmed with a table, linked to a new CRM contact, consent recorded separately", async () => {
  const r = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Sara Guest", email: `sara-${tag}@test.invalid`, phone: "+92 300 5550001", partySize: 2, date: day, time: "19:00", source: "phone", internalNote: "Regular", marketingConsent: true, idempotencyKey: `k1-${tag}` });
  assert.ok(r.reservation, r.error);
  ctx.r1 = r.reservation.id;
  assert.equal(r.reservation.status, "CONFIRMED");
  assert.deepEqual(r.reservation.tableIds, [ctx.t1], "the smallest table that fits");
  assert.match(r.reservation.ref, /^R-\d{6}$/);
  assert.ok(r.reservation.contactId);
  const contact = await db.collection("crm_contacts").findOne({ orgId, email: `sara-${tag}@test.invalid` });
  assert.equal(String(contact._id), r.reservation.contactId);
  assert.ok(await db.collection("marketing_records").findOne({ orgId, kind: "consent", email: `sara-${tag}@test.invalid` }), "marketing opt-in stored with its source");
  // the same request again returns the same booking
  const again = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Sara Guest", email: `sara-${tag}@test.invalid`, partySize: 2, date: day, time: "19:00", idempotencyKey: `k1-${tag}` });
  assert.equal(again.repeated, true);
  assert.equal(again.reservation.id, ctx.r1);
  // an existing contact is reused, not duplicated
  const second = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Sara G", email: `SARA-${tag}@test.invalid`, partySize: 2, date: addDaysKey(day, 1), time: "13:00" });
  assert.equal(second.reservation.contactId, r.reservation.contactId);
  ctx.r1b = second.reservation.id;
  assert.equal(await db.collection("crm_contacts").countDocuments({ orgId }), 1);
  // validation and permission
  assert.equal((await R.createReservation({ ...as(service), locationId: ctx.loc, name: "X", partySize: 2, date: day, time: "19:00" })).status, 403);
  assert.match((await R.createReservation({ ...as(host), locationId: ctx.loc, name: "X", partySize: 2, date: day, time: "19:10" })).error, /quarter hour/);
  assert.match((await R.createReservation({ ...as(host), locationId: ctx.loc, name: "", partySize: 2, date: day, time: "19:00" })).error, /name/);
});

test("conflict prevention: two simultaneous bookings of one table, only one wins", async () => {
  const attempt = (n) => R.createReservation({ ...as(host), locationId: ctx.loc, name: `Racer ${n}`, partySize: 3, date: day, time: "20:00", tableIds: [ctx.t2], idempotencyKey: `race-${n}-${tag}` });
  const results = await Promise.all([attempt(1), attempt(2), attempt(3), attempt(4)]);
  const won = results.filter((r) => r.reservation), lost = results.filter((r) => r.error);
  assert.equal(won.length, 1, `exactly one booking may hold the table (got ${won.length})`);
  assert.ok(lost.every((r) => r.status === 409));
  ctx.r2 = won[0].reservation.id;
  // an overlapping time on the same table is refused; a back-to-back one is allowed
  assert.equal((await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Overlap", partySize: 3, date: day, time: "21:00", tableIds: [ctx.t2] })).status, 409);
  const after = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Later", partySize: 2, date: day, time: "21:45", tableIds: [ctx.t2] });
  assert.ok(after.reservation, after.error);
  ctx.r3 = after.reservation.id;
  // losers left nothing behind: every lock belongs to a real, active reservation
  const locks = await db.collection("calendar_records").find({ orgId, kind: "h_lock" }).toArray();
  const live = new Set((await db.collection("calendar_records").find({ orgId, kind: "h_reservation" }).project({ _id: 1 }).toArray()).map((x) => String(x._id)));
  assert.ok(locks.length > 0 && locks.every((l) => live.has(String(l.reservationId))), "no orphaned table locks");
});

test("capacity: the location's guest limit can't be exceeded, even by simultaneous requests; staff may override knowingly", async () => {
  // limit is 12 guests at a time; 13:00 the next day already holds 2 (r1b)
  const d2 = addDaysKey(day, 1);
  const tries = await Promise.all([1, 2, 3, 4].map((n) => R.createReservation({ ...as(host), locationId: ctx.loc, name: `Cap ${n}`, partySize: 4, date: d2, time: "13:00", autoAssign: false, idempotencyKey: `cap-${n}-${tag}` })));
  const ok = tries.filter((r) => r.reservation).length;
  assert.equal(ok, 2, `2 + 4 + 4 = 10 fits, a third party of 4 would make 14 (got ${ok} accepted)`);
  const caps = await db.collection("calendar_records").find({ orgId, kind: "h_cap" }).toArray();
  assert.ok(caps.every((c) => c.covers <= 12 && c.covers >= 0), "no slot counter above the limit");
  const full = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Too many", partySize: 4, date: d2, time: "13:00", autoAssign: false, wantAlternatives: true });
  assert.equal(full.status, 409);
  assert.match(full.error, /fully booked/);
  assert.ok(Array.isArray(full.alternatives));
  const forced = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "VIP", partySize: 4, date: d2, time: "13:00", autoAssign: false, override: true });
  assert.ok(forced.reservation, "a member of staff can overbook on purpose");
});

test("availability and floor reflect bookings", async () => {
  const location = (await S.requireLocation(O1, host, ctx.loc)).location;
  const a = await R.availabilityFor(O1, location, day, 2);
  assert.ok(a.slots.length > 10);
  assert.equal(a.durationMinutes, 90);
  const big = await R.availabilityFor(O1, location, day, 9);
  assert.ok(big.slots.every((s) => !s.available && s.reason), "no table or pair seats nine");
  const floor = await R.floorStatus({ ...as(service), locationId: ctx.loc, at: zonedToUtc(day, "19:15", TZ).toISOString() });
  assert.equal(floor.tables.find((t) => t.id === ctx.t1).state, "reserved");
  assert.equal(floor.tables.find((t) => t.id === ctx.t3).state, "free");
  assert.equal(floor.tables.find((t) => t.id === ctx.t1).current.guestName, "Sara Guest");
  assert.equal((await R.floorStatus({ ...as(kitchen), locationId: ctx.loc })).status, 403);
});

test("lifecycle: reschedule, table change, arrival, seating, completion writes the visit to CRM", async () => {
  assert.equal((await R.updateReservation({ ...as(service), id: ctx.r1, time: "19:30" })).status, 403);
  const moved = await R.updateReservation({ ...as(host), id: ctx.r1, time: "18:30", partySize: 3 });
  assert.ok(moved.reservation, moved.error);
  assert.equal(moved.reservation.time, "18:30");
  assert.notDeepEqual(moved.reservation.tableIds, [ctx.t1], "a party of three no longer fits the two-seat table");
  assert.equal(moved.reservation.durationMinutes, 105);
  // moving onto a taken table is refused and leaves the booking as it was
  const clash = await R.updateReservation({ ...as(host), id: ctx.r1, time: "20:00", tableIds: [ctx.t2] });
  assert.equal(clash.status, 409);
  assert.equal((await R.getReservation({ ...as(host), id: ctx.r1 })).reservation.time, "18:30");
  // too early for a no-show; illegal jumps refused
  assert.equal((await R.transitionReservation({ ...as(host), id: ctx.r1, toStatus: "NO_SHOW" })).status, 409);
  assert.equal((await R.transitionReservation({ ...as(host), id: ctx.r1, toStatus: "COMPLETED" })).status, 409);
  assert.equal((await R.transitionReservation({ ...as(kitchen), id: ctx.r1, toStatus: "ARRIVED" })).status, 403);
  assert.equal((await R.transitionReservation({ ...as(service), id: ctx.r1, toStatus: "CANCELLED" })).status, 403, "service staff seat guests; they don't cancel bookings");
  assert.equal((await R.transitionReservation({ ...as(service), id: ctx.r1, toStatus: "ARRIVED" })).reservation.status, "ARRIVED");
  assert.equal((await R.transitionReservation({ ...as(service), id: ctx.r1, toStatus: "SEATED", servedByEmail: service.email })).reservation.status, "SEATED");
  assert.equal((await R.recordFeedback({ ...as(service), id: ctx.r1, rating: 5 })).status, 409, "feedback only after the visit");
  const done = await R.transitionReservation({ ...as(service), id: ctx.r1, toStatus: "COMPLETED", outcome: "Happy" });
  assert.equal(done.reservation.status, "COMPLETED");
  assert.equal(await db.collection("calendar_records").countDocuments({ orgId, kind: "h_lock", reservationId: new ObjectId(ctx.r1) }), 0, "a finished booking releases its table");
  const contact = await db.collection("crm_contacts").findOne({ orgId, email: `sara-${tag}@test.invalid` });
  assert.equal(contact.hospitality.visits, 1);
  assert.ok(contact.hospitality.lastVisitAt);
  assert.ok(await db.collection("crm_activities").findOne({ orgId, contactId: contact._id }), "the visit is logged on the CRM contact");
  assert.equal((await R.recordFeedback({ ...as(service), id: ctx.r1, rating: 9 })).error, "Rating must be from 1 to 5.");
  assert.equal((await R.recordFeedback({ ...as(service), id: ctx.r1, rating: 4, comment: "Lovely" })).feedback.rating, 4);
  // cancel frees the table and the cancelled booking can't be revived
  const cancelled = await R.transitionReservation({ ...as(host), id: ctx.r3, toStatus: "CANCELLED", reason: "Guest called" });
  assert.equal(cancelled.reservation.status, "CANCELLED");
  assert.equal((await R.transitionReservation({ ...as(host), id: ctx.r3, toStatus: "CONFIRMED" })).status, 409);
  const reuse = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "Takes freed table", partySize: 2, date: day, time: "21:45", tableIds: [ctx.t2] });
  assert.ok(reuse.reservation, "the freed table can be booked again");
});

test("service staff see the booking but not contact details, notes or history; other companies see nothing", async () => {
  const v = (await R.getReservation({ ...as(service), id: ctx.r2 })).reservation;
  assert.equal(v.guest.email, undefined); assert.equal(v.internalNote, undefined); assert.equal(v.history, undefined);
  assert.equal((await R.getReservation({ orgId: String(otherOrgId), membership: stranger, id: ctx.r2 })).status, 404);
  assert.equal((await R.transitionReservation({ orgId: String(otherOrgId), membership: stranger, actorEmail: stranger.email, id: ctx.r2, toStatus: "CANCELLED" })).status, 404);
  assert.equal((await R.listReservations({ orgId: String(otherOrgId), membership: stranger, locationId: ctx.loc })).status, 404);
  assert.equal((await R.listReservations({ ...as(outsider), locationId: ctx.loc })).status, 403);
  const list = await R.listReservations({ ...as(host), locationId: ctx.loc, from: day, to: day, q: "Racer" });
  assert.equal(list.reservations.length, 1);
  assert.equal(list.timeZone, TZ);
});

test("location scope: with two locations, a host only reaches the one they were given", async () => {
  const second = await L.createLocation({ ...as(manager), name: "Harbour", timeZone: "Asia/Dubai", currency: "AED", hours: hours([{ from: "12:00", to: "22:00" }]), policy: { leadMinutes: 0 } });
  ctx.loc2 = second.location.id;
  const hostNow = { ...host }; // no list yet, two locations
  assert.equal((await R.listReservations({ ...as(hostNow), locationId: ctx.loc })).status, 404, "no explicit access once there are several locations");
  assert.equal((await S.setStaffRole({ ...as(manager), email: host.email, locationIds: [ctx.loc] })).status, 403, "only the owner or an admin changes roles");
  assert.match((await S.setStaffRole({ ...as(owner), email: host.email, locationIds: [String(new ObjectId())] })).error, /doesn't belong/);
  assert.equal((await S.setStaffRole({ ...as(owner), email: host.email, hospitalityRole: "host", locationIds: [ctx.loc] })).ok, true);
  for (const m of [service, kitchen, stock, manager]) await S.setStaffRole({ ...as(owner), email: m.email, locationIds: [ctx.loc] });
  for (const m of [host, service, kitchen, stock, manager]) m.hospitalityLocationIds = [ctx.loc];
  assert.ok((await R.listReservations({ ...as(host), locationId: ctx.loc })).reservations);
  assert.equal((await R.listReservations({ ...as(host), locationId: ctx.loc2 })).status, 404);
  assert.equal((await R.createReservation({ ...as(host), locationId: ctx.loc2, name: "Sneak", partySize: 2, date: day, time: "19:00" })).status, 404);
  assert.equal((await L.listLocations(O1, host)).locations.length, 1);
  assert.equal((await L.listLocations(O1, owner)).locations.length, 2);
});

test("waitlist: add, suggest the next party that fits, seat as a walk-in", async () => {
  const w = await R.addToWaitlist({ ...as(host), locationId: ctx.loc, name: "Walk In", phone: "+92 300 5550002", partySize: 2, quotedMinutes: 15 });
  assert.ok(w.entry.id, w.error);
  assert.equal(w.entry.quotedMinutes, 15);
  assert.equal((await R.addToWaitlist({ ...as(service), locationId: ctx.loc, name: "X", partySize: 2 })).status, 403);
  assert.equal((await R.listWaitlist({ ...as(service), locationId: ctx.loc })).waitlist[0].guest.phone, undefined, "service staff see the name only");
  const next = await R.suggestNextParty({ ...as(host), locationId: ctx.loc });
  assert.equal(next.waiting, 1);
  const invited = await R.updateWaitlist({ ...as(host), id: w.entry.id, action: "invite" });
  assert.equal(invited.entry.status, "INVITED");
  assert.equal(invited.emailed, false, "no email address, so the screen is told nothing was sent");
  const seated = await R.updateWaitlist({ ...as(host), id: w.entry.id, action: "seat" });
  if (seated.error) assert.match(seated.error, /No free table/); else { assert.equal(seated.reservation.status, "SEATED"); assert.equal(seated.reservation.source, "walk_in"); }
  assert.equal((await R.updateWaitlist({ orgId: String(otherOrgId), membership: stranger, actorEmail: stranger.email, id: w.entry.id, action: "cancel" })).status, 404);
});

test("guests: phone-only matches are never merged automatically; export and erase are manager-only and audited", async () => {
  const contact = await db.collection("crm_contacts").findOne({ orgId, email: `sara-${tag}@test.invalid` });
  const r = await R.createReservation({ ...as(host), locationId: ctx.loc, name: "S. Guest", phone: "0300 5550001", partySize: 2, date: addDaysKey(day, 2), time: "12:00" });
  assert.equal(r.reservation.contactId, null, "a phone-only match isn't linked on its own");
  assert.deepEqual(r.reservation.matchCandidates, [String(contact._id)]);
  assert.equal((await R.listDuplicateReviews(as(host))).status, 403);
  const reviews = await R.listDuplicateReviews(as(manager));
  assert.equal(reviews.reviews.length, 1);
  assert.match((await R.resolveDuplicate({ ...as(manager), reservationId: r.reservation.id, contactId: String(new ObjectId()) })).error, /wasn't one of the suggested/);
  assert.equal((await R.resolveDuplicate({ ...as(manager), reservationId: r.reservation.id, contactId: String(contact._id) })).ok, true);
  const h = await R.guestHistory({ ...as(host), contactId: String(contact._id) });
  assert.equal(h.summary.visits, 1);
  assert.ok(h.reservations.length >= 3);
  assert.equal((await R.guestHistory({ ...as(service), contactId: String(contact._id) })).status, 403);
  assert.equal((await R.guestHistory({ orgId: String(otherOrgId), membership: stranger, contactId: String(contact._id) })).status, 404);
  assert.ok((await R.listGuests(as(host))).guests.some((g) => g.contactId === String(contact._id)));
  assert.equal((await R.exportGuest({ ...as(host), contactId: String(contact._id) })).status, 403);
  assert.ok((await R.exportGuest({ ...as(manager), contactId: String(contact._id) })).exportedAt);
  assert.match((await R.eraseGuest({ ...as(manager), contactId: String(contact._id), confirm: "yes", reason: "asked" })).error, /ERASE/);
  // an id that isn't a guest (or isn't an id at all) must never fall through to a bulk change
  const unlinkedBefore = await db.collection("calendar_records").countDocuments({ orgId, kind: "h_reservation", contactId: null, "guest.name": { $ne: "Erased guest" } });
  for (const bad of ["not-an-id", "", String(new ObjectId())]) assert.equal((await R.eraseGuest({ ...as(manager), contactId: bad, confirm: "ERASE", reason: "probe" })).status, 404);
  assert.equal(await db.collection("calendar_records").countDocuments({ orgId, kind: "h_reservation", contactId: null, "guest.name": { $ne: "Erased guest" } }), unlinkedBefore, "no unlinked reservation was anonymised");
  // a CRM contact who has never been a guest isn't reachable through guest profiles
  const lead = (await db.collection("crm_contacts").insertOne({ orgId, departmentId: deptId, type: "LEAD", name: "Not A Guest", email: `lead-${tag}@test.invalid`, createdAt: new Date().toISOString(), deletedAt: null })).insertedId;
  assert.equal((await R.guestHistory({ ...as(manager), contactId: String(lead) })).status, 404);
  assert.equal((await R.updateGuestProfile({ ...as(host), contactId: String(lead), preferences: "x" })).status, 404);
  await db.collection("crm_contacts").deleteOne({ _id: lead });
  assert.equal((await R.eraseGuest({ ...as(manager), contactId: String(contact._id), confirm: "ERASE", reason: "asked" })).status, 409, "upcoming bookings block an erase");
});

test("public page: only safe fields, real availability, idempotent booking, honeypot, token view/cancel, no token guessing", async () => {
  const slug = `hosp-${tag}`;
  const info = await R.publicInfo(slug);
  assert.equal(info.location.name, "Main Street");
  assert.equal(JSON.stringify(info).includes(owner.email), false);
  assert.equal(JSON.stringify(info).includes("warehouse"), false);
  assert.equal((await R.publicInfo("no-such-place")).status, 404);
  const slots = await R.publicSlots(slug, day, 2);
  assert.ok(slots.slots.length > 0);
  assert.ok((await R.publicSlots(slug, day, 30)).error, "online party size is capped");
  const time = slots.slots.find((s) => s.time >= "15:00" && s.time <= "17:00")?.time || slots.slots[0].time;
  const body = { name: "Web Guest", email: `web-${tag}@test.invalid`, partySize: 2, date: day, time, idempotencyKey: `web-${tag}`, note: "Window seat please", internalNote: "INJECTED", tableIds: [ctx.t3], override: true, orgId: String(otherOrgId) };
  assert.match((await R.publicBook(slug, { ...body, email: "" })).error, /email/);
  assert.match((await R.publicBook(slug, { ...body, idempotencyKey: "" })).error, /request id/);
  const bot = await R.publicBook(slug, { ...body, website: "http://spam", idempotencyKey: `bot-${tag}` });
  assert.equal(bot.ref, null);
  assert.equal(await db.collection("calendar_records").countDocuments({ orgId, kind: "h_reservation", "guest.name": "Web Guest" }), 0, "a bot submission stores nothing");
  const booked = await R.publicBook(slug, body);
  assert.ok(booked.ref, booked.error);
  assert.equal(booked.status, "CONFIRMED");
  const twice = await R.publicBook(slug, body);
  assert.equal(twice.ref, booked.ref, "a repeated submit is the same booking");
  const stored = await db.collection("calendar_records").findOne({ orgId, kind: "h_reservation", ref: booked.ref });
  assert.equal(stored.internalNote, null, "guests can't write staff notes");
  assert.equal(String(stored.orgId), O1, "the company comes from the page, never from the request");
  assert.equal(stored.source, "web");
  assert.equal(stored.manageTokenHash.length, 64);
  assert.equal(JSON.stringify(stored).includes(booked.manageToken), false, "only a hash of the link is stored");
  // larger parties wait for confirmation (policy: above 6)
  const pending = await R.publicBook(slug, { name: "Big Web", email: `big-${tag}@test.invalid`, partySize: 7, date: addDaysKey(day, 2), time: "18:00", idempotencyKey: `big-${tag}` });
  assert.ok(pending.error || pending.status === "PENDING_CONFIRMATION", "a large online party is never auto-confirmed");
  assert.equal((await R.publicBook(slug, { ...body, time: "03:00", idempotencyKey: `closed-${tag}` })).status, 409, "outside opening hours");
  // manage link
  const view = await R.publicManageView(booked.manageToken);
  assert.equal(view.reservation.ref, booked.ref);
  assert.equal(view.reservation.canCancel, true);
  assert.equal(JSON.stringify(view).includes("Window seat"), false);
  for (const bad of ["", "short", "x".repeat(40), booked.manageToken.slice(0, -1) + "A", null]) assert.equal((await R.publicManageView(bad)).status, 404);
  assert.equal((await R.publicManageAction(booked.manageToken, { action: "delete" })).error, "Unknown action.");
  assert.match((await R.publicManageAction(booked.manageToken, { action: "feedback", rating: 5 })).error, /once the visit is completed/);
  assert.equal((await R.publicManageAction(booked.manageToken, { action: "cancel" })).ok, true);
  assert.equal((await R.publicManageView(booked.manageToken)).reservation.status, "CANCELLED");
  assert.equal((await R.publicManageAction(booked.manageToken, { action: "cancel" })).status, 409, "a used cancel can't be replayed");
  assert.equal(await db.collection("calendar_records").countDocuments({ orgId, kind: "h_lock", reservationId: stored._id }), 0);
  // a page that is switched off stops working
  await L.updateLocation({ ...as(owner), locationId: ctx.loc, onlineBooking: false });
  assert.equal((await R.publicInfo(slug)).status, 404);
  assert.equal((await R.publicBook(slug, { ...body, idempotencyKey: `off-${tag}` })).status, 404);
});

test("reminders: sent once, only for confirmed future bookings", async () => {
  await db.collection("calendar_records").updateOne({ _id: new ObjectId(ctx.r2) }, { $set: { "guest.email": `racer-${tag}@test.invalid`, reminder: { dueAt: new Date(Date.now() - 60000), sentAt: null } } });
  await R.processReservationReminders();
  const first = await db.collection("calendar_records").findOne({ _id: new ObjectId(ctx.r2) });
  assert.ok(first.reminder.sentAt, "claimed");
  const before = first.reminder.sentAt;
  await R.processReservationReminders();
  assert.equal((await db.collection("calendar_records").findOne({ _id: new ObjectId(ctx.r2) })).reminder.sentAt, before, "a second pass doesn't send again");
});

test("menu: kitchen drafts, manager reviews allergens and publishes; price and allergen changes are audited", async () => {
  assert.equal((await M.saveMenu({ ...as(kitchen), name: "Dinner" })).status, 403);
  const menu = (await M.saveMenu({ ...as(manager), name: "Dinner", status: "active" })).menu;
  const cat = (await M.saveCategory({ ...as(kitchen), menuId: menu.id, name: "Mains" })).category;
  const draft = await M.saveItem({ ...as(kitchen), name: "Pancakes", categoryId: cat.id, priceMinor: 85000, currency: "PKR", allergens: ["gluten", "milk", "plutonium"], dietary: ["vegetarian"] });
  assert.ok(draft.item, draft.error);
  ctx.item = draft.item.id;
  assert.equal(draft.item.status, "draft");
  assert.deepEqual(draft.item.allergens, ["gluten", "milk"], "unknown allergens are dropped");
  assert.equal(draft.item.allergenReview, null);
  assert.equal((await M.saveItem({ ...as(kitchen), itemId: ctx.item, status: "active" })).status, 403, "kitchen staff can't publish");
  assert.equal((await M.saveItem({ ...as(host), itemId: ctx.item, name: "Hacked" })).status, 403);
  assert.equal((await M.saveItem({ ...as(manager), itemId: ctx.item, status: "active" })).status, 409, "allergen information must be reviewed before publishing");
  const live = await M.saveItem({ ...as(manager), itemId: ctx.item, status: "active", allergens: ["gluten", "milk", "eggs"] });
  assert.equal(live.item.status, "active");
  assert.equal(live.item.allergenReview.reviewedByEmail, manager.email);
  assert.equal((await M.saveItem({ ...as(kitchen), itemId: ctx.item, priceMinor: 1 })).status, 403, "a published price is manager-only");
  assert.equal((await M.saveItem({ ...as(kitchen), itemId: ctx.item, allergens: [] })).status, 403, "so is published allergen information");
  assert.ok((await M.saveItem({ ...as(kitchen), itemId: ctx.item, description: "Fluffy" })).item, "kitchen can still edit the description");
  await M.saveItem({ ...as(manager), itemId: ctx.item, priceMinor: 95000 });
  const audit = await db.collection("audit_chain_entries").find({ orgId, recordType: "HOSPITALITY_MENU_ITEM" }).toArray();
  assert.ok(audit.some((a) => a.action === "MENU_PRICE_CHANGED" && a.previousState === "85000" && a.newState === "95000"));
  assert.ok(audit.some((a) => a.action === "ALLERGEN_INFO_CHANGED"));
  const off = await M.setItemAvailability({ ...as(kitchen), itemId: ctx.item, available: false, reason: "Out of batter" });
  assert.equal(off.item.status, "unavailable");
  assert.equal(off.item.manualUnavailable.byEmail, kitchen.email);
  assert.equal((await M.setItemAvailability({ ...as(host), itemId: ctx.item, available: true })).status, 403);
  await M.setItemAvailability({ ...as(kitchen), itemId: ctx.item, available: true });
  const cat2 = await M.getCatalogue({ ...as(service), locationId: ctx.loc });
  assert.equal(cat2.items.length, 1);
  assert.match(cat2.disclaimer, /not medical advice/);
  assert.equal((await M.getCatalogue({ orgId: String(otherOrgId), membership: stranger })).items.length, 0);
});

test("recipes: ingredients from Inventory, versions kept, cost only when every ingredient has a price", async () => {
  const bad = await M.saveRecipe({ ...as(kitchen), itemId: ctx.item, recipe: { yieldServings: 4, ingredients: [{ productId: String(new ObjectId()), quantity: 1 }] } });
  assert.match(bad.error, /wasn't found/);
  const v1 = await M.saveRecipe({ ...as(kitchen), itemId: ctx.item, recipe: { yieldServings: 4, ingredients: [{ productId: String(flourId), quantity: 500, unit: "g" }, { productId: String(milkId), quantity: 600, unit: "ml" }] } });
  assert.equal(v1.item.recipe.version, 1, v1.error);
  const v2 = await M.saveRecipe({ ...as(kitchen), itemId: ctx.item, recipe: { yieldServings: 4, ingredients: [{ productId: String(flourId), quantity: 600, unit: "g", substitution: "Wholemeal flour" }, { productId: String(milkId), quantity: 600, unit: "ml" }] } });
  assert.equal(v2.item.recipe.version, 2);
  const d = await M.recipeDetail({ ...as(kitchen), itemId: ctx.item });
  assert.equal(d.history.length, 1);
  assert.equal(d.ingredients[0].onHand, 50);
  assert.equal(d.servingsPossible, 200, "30 l of milk / 0.6 l per batch of 4");
  assert.equal(d.cost.status, "insufficient_data", "milk has no purchase price, so no cost is shown");
  assert.equal(d.cost.costPerServing, undefined);
  assert.equal((await M.saveRecipe({ ...as(host), itemId: ctx.item, recipe: null })).status, 403);
  assert.equal((await M.listIngredients(as(host))).status, 403);
  assert.equal((await M.listIngredients(as(kitchen))).ingredients.length, 2);
  // stock stayed untouched by recipes and menu changes
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, 50);
});

test("wastage: small amounts reduce stock at once; large ones wait for someone else's approval", async () => {
  assert.equal((await K.recordWastage({ ...as(host), locationId: ctx.loc, productId: String(flourId), quantity: 1, reason: "spoilage" })).status, 403);
  assert.match((await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(flourId), quantity: 1, reason: "boredom" })).error, /Reason/);
  assert.match((await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(flourId), quantity: 1, reason: "other" })).error, /note/);
  assert.equal((await K.recordWastage({ ...as(kitchen), locationId: ctx.loc2, productId: String(flourId), quantity: 1, reason: "spoilage" })).status, 404, "not their location");
  const small = await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(flourId), quantity: 2, reason: "spoilage" });
  assert.equal(small.stockReduced, true, small.error);
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, 48);
  assert.equal((await K.updateStockSettings({ ...as(kitchen), wastageApprovalQuantity: 5 })).status, 403);
  await K.updateStockSettings({ ...as(manager), wastageApprovalQuantity: 5 });
  const big = await K.recordWastage({ ...as(manager), locationId: ctx.loc, productId: String(flourId), quantity: 10, reason: "damage" });
  assert.equal(big.wastage.status, "PENDING_APPROVAL");
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, 48, "stock isn't touched until it's approved");
  assert.equal((await K.decideWastage({ ...as(kitchen), id: big.wastage.id, approve: true })).status, 403);
  assert.equal((await K.decideWastage({ ...as(manager), id: big.wastage.id, approve: true })).status, 403, "nobody approves their own wastage");
  const both = await Promise.all([K.decideWastage({ ...as(owner), id: big.wastage.id, approve: true }), K.decideWastage({ ...as(owner), id: big.wastage.id, approve: true })]);
  assert.equal(both.filter((x) => x.ok).length, 1, "two simultaneous approvals reduce stock once");
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, 38);
  const tooMuch = await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(milkId), quantity: 4, reason: "expired" });
  assert.equal(tooMuch.stockReduced, true);
  assert.equal((await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(milkId), quantity: 4.5, reason: "expired" })).wastage.status, "RECORDED");
  const over = await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(milkId), quantity: 4.9, reason: "expired", note: "x" });
  assert.ok(over.wastage, "under the threshold");
  assert.equal((await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(milkId), quantity: 4.99, reason: "expired" })).wastage.status, "RECORDED");
  const none = await K.recordWastage({ ...as(kitchen), locationId: ctx.loc, productId: String(milkId), quantity: 4.999, reason: "expired" });
  assert.ok(none.wastage || none.status === 409);
  const list = await K.listWastage({ ...as(stock), locationId: ctx.loc });
  assert.ok(list.wastage.length >= 3);
  assert.equal((await K.listWastage({ orgId: String(otherOrgId), membership: stranger, locationId: ctx.loc })).status, 404);
});

test("stock count: small differences apply, large ones need a manager who didn't count", async () => {
  const flourNow = (await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity;
  const ok = await K.submitStockCount({ ...as(stock), locationId: ctx.loc, lines: [{ productId: String(flourId), counted: flourNow - 1 }] });
  assert.equal(ok.count.status, "APPLIED", ok.error);
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, flourNow - 1);
  const big = await K.submitStockCount({ ...as(stock), locationId: ctx.loc, lines: [{ productId: String(flourId), counted: 5 }] });
  assert.equal(big.count.status, "PENDING_APPROVAL");
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, flourNow - 1);
  assert.equal((await K.applyStockCount({ ...as(stock), id: big.count.id })).status, 403);
  const applied = await K.applyStockCount({ ...as(manager), id: big.count.id });
  assert.equal(applied.count.status, "APPLIED");
  assert.equal((await db.collection("stock_levels").findOne({ orgId, productId: flourId })).quantity, 5);
  assert.equal((await K.applyStockCount({ ...as(manager), id: big.count.id })).status, 409, "a count can't be applied twice");
  assert.match((await K.submitStockCount({ ...as(stock), locationId: ctx.loc, lines: [{ productId: String(flourId), counted: -1 }] })).error, /zero or more/);
  assert.match((await K.submitStockCount({ ...as(stock), locationId: ctx.loc, lines: [{ productId: String(flourId), counted: 1 }, { productId: String(flourId), counted: 2 }] })).error, /once/);
});

test("reorder: a suggestion becomes a DRAFT purchase request through the existing flow; nothing is ordered", async () => {
  const o = await K.stockOverview({ ...as(stock), locationId: ctx.loc });
  const flour = o.products.find((p) => p.productId === String(flourId));
  assert.equal(flour.low, true);
  assert.ok(flour.suggestedReorderQuantity > 0);
  assert.equal((await K.draftReorder({ ...as(kitchen), locationId: ctx.loc, productId: String(flourId) })).status, 403);
  await K.saveSupplierPreference({ ...as(stock), productId: String(flourId), supplierId: String(supplierId), category: "dry_goods", leadTimeDays: 2 });
  const d = await K.draftReorder({ ...as(stock), locationId: ctx.loc, productId: String(flourId) });
  assert.equal(d.created, true, d.error);
  assert.equal(d.request.status, "DRAFT");
  const pr = await db.collection("purchase_requests").findOne({ orgId, reorderForProductId: flourId });
  assert.equal(pr.status, "DRAFT");
  assert.equal(String(pr.supplierId), String(supplierId), "the preferred supplier is filled in");
  assert.equal((await K.draftReorder({ ...as(stock), locationId: ctx.loc, productId: String(flourId) })).created, false, "no second request while one is open");
  assert.equal(await db.collection("purchase_orders").countDocuments({ orgId }), 1, "no purchase order was created");
  assert.equal((await K.draftReorder({ ...as(stock), locationId: ctx.loc, productId: String(milkId) })).status, 409, "milk is above its reorder level");
});

test("deliveries: a discrepancy is recorded against the purchase order and resolved with a note", async () => {
  const r = await K.recordReceiving({ ...as(stock), locationId: ctx.loc, purchaseOrderId: String(poId), checks: { quantities_match: false, packaging_intact: true }, discrepancies: [{ productId: String(flourId), description: "Flour 25kg bag", expectedQuantity: 4, receivedQuantity: 3, damagedQuantity: 1 }] });
  assert.equal(r.receiving.status, "OPEN", r.error);
  assert.equal((await K.recordReceiving({ ...as(stock), locationId: ctx.loc, purchaseOrderId: String(new ObjectId()) })).status, 404);
  assert.equal((await K.recordReceiving({ ...as(host), locationId: ctx.loc, purchaseOrderId: String(poId) })).status, 403);
  assert.equal((await db.collection("purchase_orders").findOne({ _id: poId })).items[0].receivedQuantity, 0, "receiving into stock stays in Procurement");
  assert.match((await K.resolveReceiving({ ...as(stock), id: r.receiving.id, resolution: "" })).error, /Describe/);
  assert.equal((await K.resolveReceiving({ ...as(stock), id: r.receiving.id, resolution: "Credit note CN-12" })).ok, true);
  assert.equal((await K.resolveReceiving({ ...as(stock), id: r.receiving.id, resolution: "again" })).status, 409);
  const cost = await M.recipeDetail({ ...as(kitchen), itemId: ctx.item });
  assert.equal(cost.cost.status, "insufficient_data", "flour now has a purchase price but milk still doesn't");
  assert.ok((await K.listPurchaseOrders(as(stock))).orders.length === 1);
});

test("roster: drafts are private, overlaps warn, publishing notifies, swaps need a manager", async () => {
  const d = addDaysKey(day, 4);
  assert.equal((await O.saveShift({ ...as(host), locationId: ctx.loc, email: service.email, role: "server", date: d, startTime: "11:00", endTime: "17:00" })).status, 403);
  assert.match((await O.saveShift({ ...as(manager), locationId: ctx.loc, email: "nobody@test.invalid", role: "server", date: d, startTime: "11:00", endTime: "17:00" })).error, /member of staff/);
  const s = await O.saveShift({ ...as(manager), locationId: ctx.loc, email: service.email, role: "server", date: d, startTime: "11:00", endTime: "17:00" });
  assert.equal(s.shift.status, "DRAFT", s.error);
  assert.equal(s.shift.name, "Service Person", "the name comes from the HR employee record");
  const clash = await O.saveShift({ ...as(manager), locationId: ctx.loc, email: service.email, role: "server", date: d, startTime: "16:00", endTime: "22:00" });
  assert.equal(clash.status, 409);
  const late = await O.saveShift({ ...as(manager), locationId: ctx.loc, email: host.email, role: "host", date: d, startTime: "18:00", endTime: "01:00" });
  assert.ok(new Date(late.shift.end) > new Date(late.shift.start), "a shift ending after midnight runs into the next day");
  assert.equal((await O.getRoster({ ...as(service), locationId: ctx.loc, weekStart: d })).shifts.length, 0, "staff don't see drafts");
  assert.equal((await O.requestSwap({ ...as(service), shiftId: s.shift.id, toEmail: host.email })).status, 404, "a draft can't be swapped");
  assert.equal((await O.publishRoster({ ...as(host), locationId: ctx.loc, weekStart: d })).status, 403);
  assert.equal((await O.publishRoster({ ...as(manager), locationId: ctx.loc, weekStart: d })).published, 2);
  assert.equal((await O.getRoster({ ...as(service), locationId: ctx.loc, weekStart: d })).shifts.length, 2);
  assert.ok(await db.collection("notifications").findOne({ orgId: { $in: [orgId, O1] }, targetEmail: service.email, type: "shift" }), "the member of staff is told");
  assert.equal((await O.requestSwap({ ...as(host), shiftId: s.shift.id, toEmail: kitchen.email })).status, 404, "only your own shift");
  assert.equal((await O.requestSwap({ ...as(service), shiftId: s.shift.id, toEmail: kitchen.email })).ok, true);
  assert.equal((await O.decideSwap({ ...as(kitchen), shiftId: s.shift.id, approve: true })).status, 403);
  assert.equal((await O.decideSwap({ ...as(manager), shiftId: s.shift.id, approve: true })).status, "APPROVED");
  assert.equal((await db.collection("calendar_records").findOne({ _id: new ObjectId(s.shift.id) })).email, kitchen.email);
  assert.equal((await O.setUnavailable({ ...as(service), date: d, note: "Exam" })).ok, true);
  assert.ok((await O.getRoster({ ...as(manager), locationId: ctx.loc, weekStart: d })).unavailable.some((u) => u.email === service.email));
  assert.equal((await O.deleteShift({ orgId: String(otherOrgId), membership: stranger, actorEmail: stranger.email, shiftId: s.shift.id })).status, 404);
});

test("checklists: one run per day, evidence required where asked, overdue items raise one alert", async () => {
  assert.equal((await O.saveChecklistTemplate({ ...as(kitchen), locationId: ctx.loc, name: "Opening", type: "opening", items: ["Unlock"] })).status, 403);
  const t = await O.saveChecklistTemplate({ ...as(manager), locationId: ctx.loc, name: "Opening", type: "opening", items: [{ label: "Unlock", dueTime: "00:00" }, { label: "Fridge temperatures", requiresEvidence: true }] });
  assert.ok(t.template.id, t.error);
  const today = zonedDateKey(new Date(), TZ);
  const [a, b] = await Promise.all([O.startChecklistRun({ ...as(kitchen), templateId: t.template.id, date: today }), O.startChecklistRun({ ...as(service), templateId: t.template.id, date: today })]);
  assert.equal(a.run.id, b.run.id, "two people starting it get the same run");
  assert.equal(await db.collection("calendar_records").countDocuments({ orgId, kind: "h_checklist_run" }), 1);
  assert.equal((await O.updateChecklistItem({ ...as(kitchen), runId: a.run.id, n: 1, done: true })).status, 409, "needs a photo or document first");
  assert.equal((await O.updateChecklistItem({ ...as(outsider), runId: a.run.id, n: 0, done: true })).status, 403);
  const first = await O.processOverdueChecklists({ now: new Date(Date.now() + 26 * 3600000) });
  assert.ok(first.notified >= 1);
  assert.equal((await O.processOverdueChecklists({ now: new Date(Date.now() + 26 * 3600000) })).notified, 0, "one alert per checklist, not one per cron run");
  await O.updateChecklistItem({ ...as(kitchen), runId: a.run.id, n: 0, done: true });
  const done = await O.updateChecklistItem({ ...as(kitchen), runId: a.run.id, n: 1, done: true, documentId: String(new ObjectId()) });
  assert.equal(done.run.status, "COMPLETED");
  assert.equal(done.run.items[1].doneByEmail, kitchen.email);
});

test("incidents: anyone on the team can raise one; details are limited to managers and the people involved", async () => {
  const i = await O.createIncident({ ...as(service), locationId: ctx.loc, category: "guest_complaint", severity: "high", summary: "Cold food at table 2", details: "Guest was upset", reservationId: ctx.r2 });
  assert.match(i.incident.ref, /^I-\d{5}$/, i.error);
  assert.match((await O.createIncident({ ...as(service), locationId: ctx.loc, category: "aliens", summary: "x" })).error, /Category/);
  assert.equal((await O.createIncident({ ...as(service), locationId: ctx.loc, category: "equipment", summary: "x", reservationId: String(new ObjectId()) })).status, 404);
  assert.equal((await O.getIncident({ ...as(kitchen), id: i.incident.id })).status, 404, "a colleague who isn't involved can't open it");
  assert.equal((await O.listIncidents({ ...as(kitchen), locationId: ctx.loc })).incidents.length, 0);
  assert.equal((await O.listIncidents({ ...as(manager), locationId: ctx.loc })).incidents.length, 1);
  assert.equal((await O.listIncidents({ ...as(manager), locationId: ctx.loc })).incidents[0].details, undefined, "lists never carry the details");
  assert.equal((await O.updateIncident({ ...as(service), id: i.incident.id, assignedToEmail: kitchen.email })).status, 403);
  assert.equal((await O.updateIncident({ ...as(manager), id: i.incident.id, assignedToEmail: kitchen.email })).incident.assignedToEmail, kitchen.email);
  assert.ok((await O.getIncident({ ...as(kitchen), id: i.incident.id })).incident.details, "the person it's assigned to can now read it");
  assert.match((await O.updateIncident({ ...as(manager), id: i.incident.id, toStatus: "RESOLVED" })).error, /how this was resolved/);
  assert.equal((await O.updateIncident({ ...as(manager), id: i.incident.id, toStatus: "ESCALATED", note: "Owner should call" })).incident.status, "ESCALATED");
  assert.equal((await O.updateIncident({ ...as(manager), id: i.incident.id, toStatus: "RESOLVED", resolution: "Refunded the dish" })).incident.status, "RESOLVED");
  assert.equal((await O.updateIncident({ ...as(manager), id: i.incident.id, toStatus: "OPEN" })).status, 409);
  assert.equal((await O.getIncident({ orgId: String(otherOrgId), membership: stranger, actorEmail: stranger.email, id: i.incident.id })).status, 404);
  const note = await db.collection("notifications").findOne({ orgId: { $in: [orgId, O1] }, type: "incident" });
  assert.ok(note && !/Cold food|upset/.test(`${note.title} ${note.body}`), "the alert names the kind of incident, never the detail");
});

test("overview and reports: real counts, role-shaped cards, honest 'insufficient data', manager-only", async () => {
  const o = await P.hospitalityOverview({ ...as(manager), locationId: ctx.loc });
  assert.ok(o.cards.reservations && o.cards.stock && o.cards.operations, o.error);
  assert.equal(typeof o.cards.stock.lowStock, "number");
  const k = await P.hospitalityOverview({ ...as(kitchen), locationId: ctx.loc });
  assert.equal(k.cards.reservations, undefined, "kitchen staff get no reservation card");
  assert.equal(k.cards.operations.openIncidents, null);
  assert.equal((await P.hospitalityOverview(as(outsider))).status, 403);
  assert.equal((await P.hospitalityReports({ ...as(host), locationId: ctx.loc })).status, 403);
  const from = zonedDateKey(new Date(), TZ), to = addDaysKey(day, 5);
  const r = await P.hospitalityReports({ ...as(manager), locationId: ctx.loc, from, to });
  assert.ok(r.reservations.total >= 8, r.error);
  assert.equal(r.reservations.byStatus.COMPLETED, 1);
  assert.equal(r.reservations.covers >= 3, true);
  assert.equal(r.noShowRate.status, "insufficient_data", "one finished booking isn't enough for a rate");
  assert.notEqual(r.noShowRate.value, 0);
  assert.equal(r.wastage.status, "ok");
  assert.equal(r.inventoryVariance.status, "ok");
  assert.equal(r.incidents.total, 1);
  assert.match(r.purchaseSpend.note || "", /not payments/);
  assert.equal((await P.hospitalityReports({ ...as(manager), locationId: ctx.loc2 })).status, 404, "a manager limited to one location can't report on another");
  assert.match((await P.hospitalityReports({ ...as(owner), from: "2020-01-01", to: "2026-01-01" })).error, /at most one year/);
  const integ = await P.integrationStatus(as(service));
  assert.ok(integ.integrations.find((x) => x.id === "pos").status === "planned");
  assert.ok(integ.integrations.every((x) => x.status !== "connected_verified" || x.id === "email_marketing"), "nothing is called connected without proof");
  assert.notEqual(integ.integrations.find((x) => x.id === "email_marketing").status, "connected_verified", "no provider-confirmed delivery exists for this company");
});

test("campaign audience: guest-visit rule respects opt-in and unsubscribes", async () => {
  const recent = await G.resolveAudience(O1, G.normalizeRules({ guestVisit: "visited_recently", visitDays: 30 }).rules);
  assert.deepEqual(recent.recipients.map((x) => x.email), [`sara-${tag}@test.invalid`], "the guest with a completed visit");
  const lapsed = await G.resolveAudience(O1, G.normalizeRules({ guestVisit: "not_visited_recently", visitDays: 30 }).rules);
  assert.equal(lapsed.recipients.length, 0, "nobody has a visit older than 30 days");
  const never = await G.resolveAudience(O1, G.normalizeRules({ guestVisit: "never_visited", consentedOnly: true }).rules);
  assert.ok(never.recipients.every((x) => x.email !== `sara-${tag}@test.invalid`), "Sara has visited");
  const all = await G.resolveAudience(O1, G.normalizeRules({ consentedOnly: true }).rules);
  assert.deepEqual(all.recipients.map((x) => x.email), [`sara-${tag}@test.invalid`], "only the guest who opted in");
  const { suppress } = await import("../src/lib/engagement/suppression.js");
  await suppress({ orgId: O1, email: `sara-${tag}@test.invalid`, reason: "unsubscribed", source: "test" });
  assert.equal((await G.resolveAudience(O1, G.normalizeRules({ consentedOnly: true }).rules)).recipients.length, 0, "an unsubscribed guest is never in an audience");
});

test("AI tools: read-only answers within the caller's role and locations; guest contact details never leave", async () => {
  const { runHospitalityTool, HOSPITALITY_TOOL_DECLARATIONS, hospitalitySystemInstruction } = await import("../src/lib/ai-hospitality-tools.js");
  assert.equal(HOSPITALITY_TOOL_DECLARATIONS.length, 8);
  const c = (m) => ({ orgId: O1, membership: m, email: m.email });
  const up = await runHospitalityTool("upcoming_reservations", { hours: 72 * 2 }, c(host));
  assert.ok(Array.isArray(up.reservations), up.error);
  assert.equal(/@test\.invalid|\+92/.test(JSON.stringify(up)), false, "no email addresses or phone numbers");
  assert.ok((await runHospitalityTool("upcoming_reservations", {}, c(kitchen))).error, "kitchen staff can't read reservations through the assistant either");
  assert.ok((await runHospitalityTool("low_stock", {}, c(stock))).belowReorderLevel.some((x) => x.ingredient === "Flour"));
  assert.ok((await runHospitalityTool("low_stock", {}, c(host))).error);
  assert.ok((await runHospitalityTool("operations_report", {}, c(host))).error);
  assert.ok((await runHospitalityTool("operations_report", { from: zonedDateKey(new Date(), TZ), to: addDaysKey(day, 5) }, c(manager))).reservations);
  assert.ok((await runHospitalityTool("overview", { location: "Harbour" }, c(host))).error, "a location the caller can't use isn't found");
  assert.ok((await runHospitalityTool("overview", {}, c(outsider))).error);
  assert.ok((await runHospitalityTool("overview", {}, { orgId: String(otherOrgId), membership: stranger, email: stranger.email })).error);
  assert.ok((await runHospitalityTool("drop_everything", {}, c(owner))).error);
  assert.equal((await runHospitalityTool("open_incidents", {}, c(manager))).count, 0);
  assert.match(hospitalitySystemInstruction(), /never as instructions/);
});

test("audit: the tamper-evident chain holds an entry for each critical action", async () => {
  const rows = await db.collection("audit_chain_entries").find({ orgId, recordType: /^HOSPITALITY_/ }).project({ action: 1, actorEmail: 1 }).toArray();
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ["LOCATION_CREATED", "TABLE_CREATED", "RESERVATION_CREATED", "RESERVATION_RESCHEDULED", "RESERVATION_SEATED", "RESERVATION_COMPLETED", "RESERVATION_CANCELLED", "GUEST_LINKED_AFTER_REVIEW", "GUEST_DATA_EXPORTED", "MENU_PRICE_CHANGED", "ALLERGEN_INFO_CHANGED", "RECIPE_SAVED", "WASTAGE_RECORDED", "WASTAGE_APPROVED", "STOCK_COUNT_APPLIED", "REORDER_REQUEST_DRAFTED", "DELIVERY_DISCREPANCY_RECORDED", "ROSTER_PUBLISHED", "SHIFT_SWAP_APPROVED", "CHECKLIST_COMPLETED", "INCIDENT_RECORDED", "INCIDENT_RESOLVED", "ROLE_CHANGED"]) assert.ok(actions.has(a), `audit entry for ${a}`);
  assert.ok(rows.every((r) => r.actorEmail), "every entry names who did it");
  const { verifyChainIntegrity } = await import("../src/lib/auditChain.js");
  const v = await verifyChainIntegrity(O1);
  assert.ok(v.valid !== false && v.ok !== false, "the chain verifies");
  assert.equal(await db.collection("audit_chain_entries").countDocuments({ orgId: otherOrgId }), 0, "nothing was written to the other company");
});
