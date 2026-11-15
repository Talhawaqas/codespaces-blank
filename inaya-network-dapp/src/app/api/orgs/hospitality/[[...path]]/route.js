// app/api/orgs/hospitality/[[...path]]/route.js -- Hospitality & Food Service Workspace. Session + membership, then
// requireVertical(orgId, "hospitality") before ANY hospitality logic runs (test/vertical-lock-wiring.test.mjs checks this).
// Role and location checks live in src/lib/hospitality/*; this file only routes. orgId comes from the query or body and
// is never trusted on its own: requireMembership proves the caller belongs to it.
//
//   GET overview (?locationId)                 GET options
//   GET|POST locations                         PATCH locations/{id}
//   GET locations/{id}/seating                 POST locations/{id}/areas | tables        DELETE locations/{id}/areas|tables/{id}
//   GET locations/{id}/availability?date&partySize     GET locations/{id}/floor
//   GET|POST reservations (?locationId&from&to&status&tableId&areaId&q&page)
//   GET|PATCH reservations/{id}                POST reservations/{id}/transition { toStatus, reason, outcome }   POST reservations/{id}/feedback
//   GET|POST waitlist (?locationId)            GET waitlist/next?locationId               POST waitlist/{id} { action, tableIds }
//   GET guests/duplicates                      POST guests/duplicates/{reservationId} { contactId|null }
//   GET guests/{contactId}                     PATCH guests/{contactId}     GET guests/{contactId}/export    POST guests/{contactId}/erase
//   GET menu (?locationId)                     POST menu/menus | categories | items       PATCH menu/items/{id}
//   POST menu/items/{id}/availability          GET|PUT menu/items/{id}/recipe             GET menu/suggestions
//   GET stock (?locationId&q&lowOnly)          POST stock/reorder { productId }           PUT stock/suppliers { productId, ... }   PUT stock/settings
//   GET|POST stock/wastage                     POST stock/wastage/{id}/decide { approve }
//   GET|POST stock/counts                      POST stock/counts/{id}/decide { approve }
//   GET|POST stock/receiving                   POST stock/receiving/{id}/resolve { resolution }
//   GET roster (?locationId&weekStart)         POST roster/shifts   PATCH|DELETE roster/shifts/{id}   POST roster/publish   PUT roster/unavailable
//   POST roster/shifts/{id}/swap { toEmail }   POST roster/shifts/{id}/swap/decide { approve }
//   GET checklists (?locationId&date)          POST checklists/templates   POST checklists/runs { templateId }   PATCH checklists/runs/{id} { n, done, note }
//   GET|POST incidents                         GET|PATCH incidents/{id}
//   GET reports (?locationId&from&to&format=csv)        GET integrations
//   GET staff-roles                            PUT staff-roles { email, hospitalityRole, locationIds }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import * as S from "../../../../../lib/hospitality/store.js";
import * as LOC from "../../../../../lib/hospitality/locations.js";
import * as RES from "../../../../../lib/hospitality/reservations.js";
import * as MENU from "../../../../../lib/hospitality/menu.js";
import * as STOCK from "../../../../../lib/hospitality/stock.js";
import * as OPS from "../../../../../lib/hospitality/operations.js";
import * as REP from "../../../../../lib/hospitality/reports.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error, ...(r.alternatives ? { alternatives: r.alternatives } : {}), ...(r.warnings ? { warnings: r.warnings } : {}) }, r.status || 400) : json(r, ok));

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const q = Object.fromEntries(new URL(req.url).searchParams.entries()); let body = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { body = await req.json(); } catch { body = {}; } }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const verticalCheck = await requireVertical(orgId, "hospitality"); if (verticalCheck.error) return json({ error: verticalCheck.error }, verticalCheck.status);
    const membership = auth.membership, actorEmail = auth.session.email;
    if (!S.canAccessHospitality(membership)) return json({ error: "You have no role in the Hospitality workspace. Ask the owner or an admin to give you one." }, 403);
    await S.ensureHospitalityIndexes();
    // orgId, membership and actorEmail always come from the session, never from the request body.
    const { orgId: _o, membership: _m, actorEmail: _a, ...input } = body;
    const base = { orgId, membership, actorEmail }; const [a, b, c, d] = path; const loc = q.locationId || input.locationId;

    if (a === "overview" && method === "GET") return out(await REP.hospitalityOverview({ ...base, locationId: q.locationId }));
    if (a === "options" && method === "GET") return json({ roles: S.HOSPITALITY_ROLES, role: S.hRole(membership), can: S.capabilitiesOf(membership), statuses: RES.STATUSES, transitions: RES.TRANSITIONS, sources: RES.SOURCES, types: RES.TYPES, wastageReasons: STOCK.WASTAGE_REASONS, supplierCategories: STOCK.SUPPLIER_CATEGORIES, shiftRoles: OPS.SHIFT_ROLES, incidentCategories: OPS.INCIDENT_CATEGORIES, defaultPolicy: LOC.DEFAULT_POLICY });

    if (a === "warehouses" && method === "GET") return out(await LOC.listWarehouses(base));
    if (a === "locations") {
      if (!b && method === "GET") return out(await LOC.listLocations(orgId, membership));
      if (!b && method === "POST") return out(await LOC.createLocation({ ...input, ...base }), 201);
      if (b && !c && method === "PATCH") return out(await LOC.updateLocation({ ...input, ...base, locationId: b }));
      if (b && c === "seating" && method === "GET") return out(await LOC.getSeating({ ...base, locationId: b }));
      if (b && c === "areas" && !d && method === "POST") return out(await LOC.saveArea({ ...input, ...base, locationId: b }));
      if (b && c === "tables" && !d && method === "POST") return out(await LOC.saveTable({ ...input, ...base, locationId: b }));
      if (b && (c === "areas" || c === "tables") && d && method === "DELETE") return out(await LOC.removeSeating({ ...base, locationId: b, kind: c === "areas" ? "area" : "table", id: d }));
      if (b && c === "floor" && method === "GET") return out(await RES.floorStatus({ ...base, locationId: b, at: q.at }));
      if (b && c === "availability" && method === "GET") {
        if (!S.CAN.reservationsRead(membership)) return json({ error: "You have no access to reservations." }, 403);
        const got = await S.requireLocation(orgId, membership, b); if (got.error) return out(got);
        const n = S.intIn(q.partySize, 1, 500); if (n === null) return json({ error: "Party size must be a whole number of guests." }, 400);
        return out(await RES.availabilityFor(orgId, got.location, q.date, n));
      }
    }
    if (a === "reservations") {
      if (!b && method === "GET") return out(await RES.listReservations({ ...base, locationId: q.locationId, from: q.from, to: q.to, status: q.status, tableId: q.tableId, areaId: q.areaId, q: q.q, page: q.page, limit: q.limit }));
      if (!b && method === "POST") return out(await RES.createReservation({ ...input, ...base, locationId: loc }), 201);
      if (b && !c && method === "GET") return out(await RES.getReservation({ ...base, id: b }));
      if (b && !c && method === "PATCH") return out(await RES.updateReservation({ ...input, ...base, id: b }));
      if (b && c === "transition" && method === "POST") return out(await RES.transitionReservation({ ...base, id: b, toStatus: input.toStatus, reason: input.reason, outcome: input.outcome, servedByEmail: input.servedByEmail }));
      if (b && c === "feedback" && method === "POST") return out(await RES.recordFeedback({ ...base, id: b, rating: input.rating, comment: input.comment }));
    }
    if (a === "waitlist") {
      if (!b && method === "GET") return out(await RES.listWaitlist({ ...base, locationId: q.locationId, includeClosed: q.includeClosed === "1" }));
      if (!b && method === "POST") return out(await RES.addToWaitlist({ ...input, ...base, locationId: loc }), 201);
      if (b === "next" && method === "GET") return out(await RES.suggestNextParty({ ...base, locationId: q.locationId }));
      if (b && method === "POST") return out(await RES.updateWaitlist({ ...base, id: b, action: input.action, tableIds: input.tableIds, holdMinutes: input.holdMinutes }));
    }
    if (a === "guests") {
      if (!b && method === "GET") return out(await RES.listGuests({ ...base, q: q.q, limit: q.limit }));
      if (b === "duplicates" && !c && method === "GET") return out(await RES.listDuplicateReviews(base));
      if (b === "duplicates" && c && method === "POST") return out(await RES.resolveDuplicate({ ...base, reservationId: c, contactId: input.contactId || null }));
      if (b && !c && method === "GET") return out(await RES.guestHistory({ ...base, contactId: b }));
      if (b && !c && method === "PATCH") return out(await RES.updateGuestProfile({ ...base, contactId: b, preferences: input.preferences, preferredChannel: input.preferredChannel, preferredLocationId: input.preferredLocationId }));
      if (b && c === "export" && method === "GET") return out(await RES.exportGuest({ ...base, contactId: b }));
      if (b && c === "erase" && method === "POST") return out(await RES.eraseGuest({ ...base, contactId: b, confirm: input.confirm, reason: input.reason }));
    }
    if (a === "menu") {
      if (!b && method === "GET") return out(await MENU.getCatalogue({ ...base, locationId: q.locationId, includeArchived: q.includeArchived === "1" }));
      if (b === "suggestions" && method === "GET") return out(await MENU.availabilitySuggestions(base));
      if (b === "ingredients" && method === "GET") return out(await MENU.listIngredients({ ...base, q: q.q }));
      if (b === "menus" && method === "POST") return out(await MENU.saveMenu({ ...input, ...base }));
      if (b === "categories" && method === "POST") return out(await MENU.saveCategory({ ...input, ...base }));
      if (b === "items" && !c && method === "POST") return out(await MENU.saveItem({ ...input, ...base, itemId: undefined }), 201);
      if (b === "items" && c && !d && method === "PATCH") return out(await MENU.saveItem({ ...input, ...base, itemId: c }));
      if (b === "items" && c && d === "availability" && method === "POST") return out(await MENU.setItemAvailability({ ...base, itemId: c, available: input.available === true, reason: input.reason }));
      if (b === "items" && c && d === "recipe" && method === "GET") return out(await MENU.recipeDetail({ ...base, itemId: c }));
      if (b === "items" && c && d === "recipe" && method === "PUT") return out(await MENU.saveRecipe({ ...base, itemId: c, recipe: input.recipe ?? null }));
    }
    if (a === "stock") {
      if (!b && method === "GET") return out(await STOCK.stockOverview({ ...base, locationId: q.locationId, q: q.q, lowOnly: q.lowOnly === "1" }));
      if (b === "purchase-orders" && method === "GET") return out(await STOCK.listPurchaseOrders(base));
      if (b === "reorder" && method === "POST") return out(await STOCK.draftReorder({ ...base, locationId: loc, productId: input.productId }));
      if (b === "suppliers" && method === "PUT") return out(await STOCK.saveSupplierPreference({ ...input, ...base }));
      if (b === "settings" && method === "PUT") return out(await STOCK.updateStockSettings({ ...input, ...base }));
      if (b === "wastage" && !c && method === "GET") return out(await STOCK.listWastage({ ...base, locationId: q.locationId, from: q.from, to: q.to, status: q.status }));
      if (b === "wastage" && !c && method === "POST") return out(await STOCK.recordWastage({ ...input, ...base, locationId: loc }), 201);
      if (b === "wastage" && c && d === "decide" && method === "POST") return out(await STOCK.decideWastage({ ...base, id: c, approve: input.approve === true, note: input.note }));
      if (b === "counts" && !c && method === "GET") return out(await STOCK.listStockCounts({ ...base, locationId: q.locationId }));
      if (b === "counts" && !c && method === "POST") return out(await STOCK.submitStockCount({ ...base, locationId: loc, lines: input.lines, note: input.note }), 201);
      if (b === "counts" && c && d === "decide" && method === "POST") return out(await STOCK.applyStockCount({ ...base, id: c, reject: input.approve !== true }));
      if (b === "receiving" && !c && method === "GET") return out(await STOCK.listReceiving({ ...base, locationId: q.locationId, status: q.status }));
      if (b === "receiving" && !c && method === "POST") return out(await STOCK.recordReceiving({ ...input, ...base, locationId: loc }), 201);
      if (b === "receiving" && c && d === "resolve" && method === "POST") return out(await STOCK.resolveReceiving({ ...base, id: c, resolution: input.resolution }));
    }
    if (a === "roster") {
      if (!b && method === "GET") return out(await OPS.getRoster({ ...base, locationId: q.locationId, weekStart: q.weekStart }));
      if (b === "publish" && method === "POST") return out(await OPS.publishRoster({ ...base, locationId: loc, weekStart: input.weekStart }));
      if (b === "unavailable" && method === "PUT") return out(await OPS.setUnavailable({ ...base, date: input.date, note: input.note, remove: input.remove === true }));
      if (b === "shifts" && !c && method === "POST") return out(await OPS.saveShift({ ...input, ...base, locationId: loc, shiftId: undefined }), 201);
      if (b === "shifts" && c && !d && method === "PATCH") return out(await OPS.saveShift({ ...input, ...base, locationId: loc, shiftId: c }));
      if (b === "shifts" && c && !d && method === "DELETE") return out(await OPS.deleteShift({ ...base, shiftId: c }));
      if (b === "shifts" && c && d === "swap" && !path[4] && method === "POST") return out(await OPS.requestSwap({ ...base, shiftId: c, toEmail: input.toEmail, note: input.note }));
      if (b === "shifts" && c && d === "swap" && path[4] === "decide" && method === "POST") return out(await OPS.decideSwap({ ...base, shiftId: c, approve: input.approve === true, allowOverlap: input.allowOverlap === true }));
    }
    if (a === "checklists") {
      if (!b && method === "GET") return out(await OPS.listChecklists({ ...base, locationId: q.locationId, date: q.date }));
      if (b === "templates" && method === "POST") return out(await OPS.saveChecklistTemplate({ ...input, ...base, locationId: loc }));
      if (b === "runs" && !c && method === "POST") return out(await OPS.startChecklistRun({ ...base, templateId: input.templateId, date: input.date }));
      if (b === "runs" && c && method === "PATCH") return out(await OPS.updateChecklistItem({ ...base, runId: c, n: input.n, done: input.done, note: input.note, documentId: input.documentId, ownerEmail: input.ownerEmail }));
    }
    if (a === "incidents") {
      if (!b && method === "GET") return out(await OPS.listIncidents({ ...base, locationId: q.locationId, status: q.status }));
      if (!b && method === "POST") return out(await OPS.createIncident({ ...input, ...base, locationId: loc }), 201);
      if (b && method === "GET") return out(await OPS.getIncident({ ...base, id: b }));
      if (b && method === "PATCH") return out(await OPS.updateIncident({ ...input, ...base, id: b }));
    }
    if (a === "reports" && method === "GET") {
      const r = await REP.hospitalityReports({ ...base, locationId: q.locationId, from: q.from, to: q.to });
      if (r.error || q.format !== "csv") return out(r);
      await S.logH({ orgId, recordType: "REPORT", recordId: null, actorEmail, action: "REPORT_EXPORTED", metadata: { from: r.range.from, to: r.range.to, locationId: q.locationId || "all" } });
      return new NextResponse(REP.reportsCsv(r), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="hospitality-report-${r.range.from}-to-${r.range.to}.csv"`, "Cache-Control": "no-store" } });
    }
    if (a === "integrations" && method === "GET") return out(await REP.integrationStatus(base));
    if (a === "staff-roles") {
      if (method === "GET") return out(await S.listStaffRoles(orgId, membership));
      if (method === "PUT") return out(await S.setStaffRole({ ...base, email: input.email, hospitalityRole: input.hospitalityRole, locationIds: input.locationIds }));
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err?.name === "BSONError" || /input must be a 24 character hex string|Argument passed in must be/i.test(String(err?.message))) return json({ error: "Invalid id." }, 400);
    console.error("orgs/hospitality failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export async function GET(req, ctx) { return handle(req, ctx); }
export async function POST(req, ctx) { return handle(req, ctx); }
export async function PUT(req, ctx) { return handle(req, ctx); }
export async function PATCH(req, ctx) { return handle(req, ctx); }
export async function DELETE(req, ctx) { return handle(req, ctx); }
