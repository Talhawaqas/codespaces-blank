// src/lib/hospitality/reports.js
//
// Hospitality overview and reports (SOW 18). Every figure is computed from stored records for an explicit date
// range and location, in the location's time zone (the `date` key on each record is already local). Where there
// isn't enough data, the metric says "insufficient_data" instead of showing zero (SOW 18.3). Nothing is hardcoded.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { zonedDateKey, addDaysKey, zonedToUtc } from "../engagement/time.js";
import { isLowStock } from "../inventory.js";
import { hcol, KINDS, CAN, fail, oid, allowedLocations, requireLocation, canAccessHospitality, capabilitiesOf, hRole } from "./store.js";
import { ACTIVE } from "./reservations.js";
import { operationsSummary } from "./operations.js";
import { publicLocation } from "./locations.js";

export const METRIC_DEFINITIONS = {
  reservations: "Reservations whose date falls in the range, by status. Cancelled, declined and no-show bookings are counted separately and never as covers.",
  covers: "Guests in reservations that were seated or completed (party sizes added together).",
  noShowRate: "No-shows divided by reservations that reached their time: completed + seated + no-show. Cancelled bookings are left out.",
  cancellationRate: "Cancelled divided by all reservations made for the range (excluding declined requests).",
  sourceMix: "Share of reservations by where they came from (staff, phone, walk-in, web).",
  repeatGuests: "Guests linked to the CRM with more than one completed visit ever, among guests with a completed visit in the range.",
  waitlistConversion: "Waitlist entries that were seated, divided by entries closed in the range (seated + expired + cancelled).",
  wastage: "Recorded or approved wastage quantity by ingredient and reason. Pending and rejected records are left out.",
  inventoryVariance: "Lines in applied stock counts where the counted quantity differed from the system quantity.",
  purchaseSpend: "Value of purchase orders created in the range (quantity x unit price), by supplier. Not payments.",
  checklists: "Checklist runs completed, out of runs started in the range.",
  incidents: "Incidents recorded in the range by category, and how many are still open.",
  campaigns: "Taken from the Campaigns module: sends, deliveries, bounces and unsubscribes as reported by the email provider.",
};

/** Pure: a rate with its numerator and denominator, or "insufficient_data" below `min` observations. */
export function rate(numerator, denominator, min = 5) {
  if (!denominator || denominator < min) return { status: "insufficient_data", numerator, denominator: denominator || 0, needed: min };
  return { status: "ok", value: Math.round((numerator / denominator) * 1000) / 10, numerator, denominator };
}

async function scope(orgId, membership, locationId) {
  if (locationId) { const got = await requireLocation(orgId, membership, locationId); return got.error ? got : { locations: [got.location] }; }
  const locations = await allowedLocations(orgId, membership);
  return { locations };
}

/** Overview cards (SOW 18.1). Each card appears only when the caller may see that area. */
export async function hospitalityOverview({ orgId, membership, actorEmail, locationId, now = new Date() }) {
  if (!canAccessHospitality(membership)) return fail("You don't have access to the Hospitality workspace.", 403);
  const all = await allowedLocations(orgId, membership);
  const sc = locationId ? await scope(orgId, membership, locationId) : { locations: all };
  if (sc.error) return sc;
  const base = { role: hRole(membership), can: capabilitiesOf(membership), locations: all.map(publicLocation), setup: { hasLocation: all.length > 0 } };
  if (!sc.locations.length) return { ...base, cards: null };
  const c = await hcol();
  const org = toObjectId(orgId);
  const locIds = sc.locations.map((l) => l._id);
  // "Today" is each location's own local day.
  const todayByLoc = sc.locations.map((l) => ({ locationId: l._id, date: zonedDateKey(now, l.timeZone) }));
  const cards = {};
  if (CAN.reservationsRead(membership)) {
    const rows = await c.find({ orgId: org, kind: KINDS.reservation, $or: todayByLoc }).project({ status: 1, partySize: 1, tableIds: 1, type: 1, start: 1 }).toArray();
    const count = (s) => rows.filter((r) => s.includes(r.status)).length;
    const [waiting, events, dupes] = await Promise.all([
      c.countDocuments({ orgId: org, kind: KINDS.waitlist, locationId: { $in: locIds }, status: { $in: ["WAITING", "INVITED"] } }),
      c.countDocuments({ orgId: org, kind: KINDS.reservation, locationId: { $in: locIds }, type: { $ne: "table" }, status: { $in: ACTIVE }, start: { $gt: now } }),
      CAN.manage(membership) ? c.countDocuments({ orgId: org, kind: KINDS.reservation, locationId: { $in: locIds }, contactId: null, "matchCandidates.0": { $exists: true } }) : null,
    ]);
    cards.reservations = { today: rows.filter((r) => !["CANCELLED", "DECLINED"].includes(r.status)).length, expectedCovers: rows.filter((r) => ACTIVE.includes(r.status)).reduce((n, r) => n + r.partySize, 0), pendingConfirmation: count(["REQUESTED", "PENDING_CONFIRMATION"]), arrived: count(["ARRIVED"]), seated: count(["SEATED"]), completed: count(["COMPLETED"]), noShows: count(["NO_SHOW"]), unassigned: rows.filter((r) => ACTIVE.includes(r.status) && !(r.tableIds || []).length).length, waitlist: waiting, upcomingPrivateEvents: events, duplicateReviews: dupes };
  }
  if (CAN.stockRead(membership)) {
    const whs = sc.locations.map((l) => l.warehouseId).filter(Boolean);
    if (whs.length) {
      const { products, stockLevels, purchaseRequests } = await getOrgCollections();
      const [ps, lv, pending] = await Promise.all([products.find({ orgId: org, deletedAt: null, reorderThreshold: { $gt: 0 } }).project({ reorderThreshold: 1 }).limit(5000).toArray(), stockLevels.find({ orgId: org, warehouseId: { $in: whs } }).project({ productId: 1, quantity: 1 }).toArray(), purchaseRequests.countDocuments({ orgId: org, deletedAt: null, status: { $in: ["DRAFT", "SUBMITTED"] } })]);
      const q = new Map(); for (const l of lv) q.set(String(l.productId), (q.get(String(l.productId)) || 0) + l.quantity);
      const [wastePending, openDeliveries] = await Promise.all([c.countDocuments({ orgId: org, kind: KINDS.wastage, locationId: { $in: locIds }, status: "PENDING_APPROVAL" }), c.countDocuments({ orgId: org, kind: KINDS.receiving, locationId: { $in: locIds }, status: "OPEN" })]);
      cards.stock = { lowStock: ps.filter((p) => isLowStock(p, q.get(String(p._id)) || 0)).length, pendingPurchaseRequests: pending, wastageAwaitingApproval: wastePending, openDeliveryIssues: openDeliveries };
    } else cards.stock = { status: "not_linked", message: "Link a stock location in Settings to see stock here." };
  }
  cards.operations = await operationsSummary(orgId, membership, locIds, todayByLoc[0].date);
  const myShift = await c.findOne({ orgId: org, kind: KINDS.shift, email: String(actorEmail || "").toLowerCase(), status: "PUBLISHED", end: { $gt: now } }, { sort: { start: 1 }, projection: { date: 1, startTime: 1, endTime: 1, role: 1, locationId: 1 } });
  cards.myNextShift = myShift ? { date: myShift.date, startTime: myShift.startTime, endTime: myShift.endTime, role: myShift.role, locationId: String(myShift.locationId) } : null;
  return { ...base, cards, generatedAt: now.toISOString() };
}

const tally = (rows, key) => { const m = {}; for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; m[k] = (m[k] || 0) + 1; } return m; };

export async function hospitalityReports({ orgId, membership, locationId, from, to, now = new Date() }) {
  if (!CAN.reports(membership)) return fail("Only a manager can see reports.", 403);
  const sc = await scope(orgId, membership, locationId);
  if (sc.error) return sc;
  if (!sc.locations.length) return fail("Add a location first.", 409);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : zonedDateKey(now, sc.locations[0].timeZone);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : addDaysKey(end, -29);
  if (start > end || end > addDaysKey(start, 366)) return fail("Choose a range of at most one year.");
  const c = await hcol();
  const org = toObjectId(orgId), locIds = sc.locations.map((l) => l._id), inRange = { $gte: start, $lte: end };
  const { purchaseOrders, suppliers, products, crmContacts } = await getOrgCollections();
  const [res, wait, waste, counts, runs, incidents, pos] = await Promise.all([
    c.find({ orgId: org, kind: KINDS.reservation, locationId: { $in: locIds }, date: inRange }).project({ status: 1, source: 1, partySize: 1, date: 1, contactId: 1, feedback: 1, type: 1 }).limit(50000).toArray(),
    c.find({ orgId: org, kind: KINDS.waitlist, locationId: { $in: locIds }, createdAt: { $gte: `${start}T00:00:00.000Z`, $lte: `${addDaysKey(end, 1)}T23:59:59.999Z` } }).project({ status: 1 }).limit(20000).toArray(),
    c.find({ orgId: org, kind: KINDS.wastage, locationId: { $in: locIds }, date: inRange, status: { $in: ["RECORDED", "APPROVED"] } }).project({ productId: 1, quantity: 1, unit: 1, reason: 1 }).limit(20000).toArray(),
    c.find({ orgId: org, kind: KINDS.count, locationId: { $in: locIds }, date: inRange, status: { $in: ["APPLIED", "APPLIED_WITH_ERRORS"] } }).project({ lines: 1 }).limit(2000).toArray(),
    c.find({ orgId: org, kind: KINDS.checklistRun, locationId: { $in: locIds }, date: inRange }).project({ status: 1, type: 1 }).limit(20000).toArray(),
    c.find({ orgId: org, kind: KINDS.incident, locationId: { $in: locIds }, date: inRange }).project({ category: 1, status: 1, severity: 1 }).limit(20000).toArray(),
    purchaseOrders.find({ orgId: org, deletedAt: null, createdAt: { $gte: zonedToUtc(start, "00:00", sc.locations[0].timeZone || "UTC").toISOString(), $lt: zonedToUtc(addDaysKey(end, 1), "00:00", sc.locations[0].timeZone || "UTC").toISOString() } /* the restaurant's local days, not UTC days */ }).project({ supplierId: 1, items: 1, currency: 1 }).limit(5000).toArray(),
  ]);

  const n = (s) => res.filter((r) => s.includes(r.status)).length;
  const reached = n(["COMPLETED", "SEATED", "NO_SHOW"]);
  const made = res.filter((r) => r.status !== "DECLINED").length;
  const completedContacts = [...new Set(res.filter((r) => r.status === "COMPLETED" && r.contactId).map((r) => String(r.contactId)))];
  const repeat = completedContacts.length ? await crmContacts.countDocuments({ _id: { $in: completedContacts.map((x) => toObjectId(x)) }, orgId: org, "hospitality.visits": { $gt: 1 } }) : 0;
  const ratings = res.filter((r) => r.feedback?.rating).map((r) => r.feedback.rating);
  const closedWait = wait.filter((w) => ["SEATED", "EXPIRED", "CANCELLED"].includes(w.status));

  const wasteNames = new Map((await products.find({ _id: { $in: [...new Set(waste.map((w) => String(w.productId)))].map((x) => toObjectId(x)) }, orgId: org }).project({ name: 1 }).toArray()).map((p) => [String(p._id), p.name]));
  const byIngredient = {}; for (const w of waste) { const k = String(w.productId); byIngredient[k] = byIngredient[k] || { name: wasteNames.get(k) || "Removed product", unit: w.unit, quantity: 0, records: 0 }; byIngredient[k].quantity += w.quantity; byIngredient[k].records++; }
  const lines = counts.flatMap((d) => d.lines);
  const spend = {}; for (const po of pos) { const k = String(po.supplierId || "none"); const v = (po.items || []).reduce((s, i) => s + (i.quantity || 0) * (i.unitPrice || 0), 0); const cur = po.currency || "?"; spend[`${k}|${cur}`] = (spend[`${k}|${cur}`] || 0) + v; }
  const supNames = new Map((await suppliers.find({ orgId: org, _id: { $in: [...new Set(pos.map((p) => p.supplierId).filter(Boolean).map(String))].map((x) => toObjectId(x)) } }).project({ name: 1 }).toArray()).map((s) => [String(s._id), s.name]));

  let campaigns = { status: "not_available" };
  try {
    const { engagementCollections } = await import("../engagement/store.js");
    const { marketing } = await engagementCollections();
    const sends = await marketing.aggregate([{ $match: { orgId: org, kind: "send", createdAt: { $gte: zonedToUtc(start, "00:00", sc.locations[0].timeZone || "UTC").toISOString(), $lt: zonedToUtc(addDaysKey(end, 1), "00:00", sc.locations[0].timeZone || "UTC").toISOString() } /* the restaurant's local days, not UTC days */ } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray();
    campaigns = sends.length ? { status: "ok", byStatus: Object.fromEntries(sends.map((s) => [s._id, s.n])), note: "Provider-reported states. An open is not proof that someone read the email." } : { status: "insufficient_data", note: "No campaign emails were sent in this range." };
  } catch { /* campaigns module unavailable: reported as not_available */ }

  return {
    range: { from: start, to: end }, locations: sc.locations.map((l) => ({ id: String(l._id), name: l.name, timeZone: l.timeZone })), definitions: METRIC_DEFINITIONS,
    reservations: { total: res.length, byStatus: tally(res, "status"), byDate: tally(res.filter((r) => !["CANCELLED", "DECLINED"].includes(r.status)), "date"), covers: res.filter((r) => ["SEATED", "COMPLETED"].includes(r.status)).reduce((s, r) => s + r.partySize, 0), privateEvents: res.filter((r) => r.type !== "table").length },
    noShowRate: rate(n(["NO_SHOW"]), reached), cancellationRate: rate(n(["CANCELLED"]), made),
    sourceMix: res.length >= 5 ? { status: "ok", bySource: tally(res, "source") } : { status: "insufficient_data", needed: 5, have: res.length },
    repeatGuests: rate(repeat, completedContacts.length),
    feedback: ratings.length >= 3 ? { status: "ok", average: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10, responses: ratings.length } : { status: "insufficient_data", needed: 3, have: ratings.length },
    waitlistConversion: rate(closedWait.filter((w) => w.status === "SEATED").length, closedWait.length),
    wastage: waste.length ? { status: "ok", records: waste.length, byReason: tally(waste, "reason"), byIngredient: Object.values(byIngredient).sort((a, b) => b.records - a.records).slice(0, 25) } : { status: "insufficient_data", note: "No wastage was recorded in this range." },
    inventoryVariance: lines.length ? { status: "ok", countsApplied: counts.length, linesCounted: lines.length, linesWithVariance: lines.filter((l) => l.difference !== 0).length, largest: lines.filter((l) => l.difference !== 0).sort((a, b) => b.variancePercent - a.variancePercent).slice(0, 10).map((l) => ({ name: l.name, system: l.system, counted: l.counted, difference: l.difference, variancePercent: l.variancePercent })) } : { status: "insufficient_data", note: "No stock counts were applied in this range." },
    purchaseSpend: pos.length ? { status: "ok", orders: pos.length, bySupplier: Object.entries(spend).map(([k, v]) => { const [sid2, cur] = k.split("|"); return { supplier: supNames.get(sid2) || "No supplier", currency: cur, value: Math.round(v * 100) / 100 }; }).sort((a, b) => b.value - a.value), note: "Order value, not payments. Food cost isn't calculated: sales data isn't connected." } : { status: "insufficient_data", note: "No purchase orders were created in this range." },
    checklists: runs.length ? { status: "ok", started: runs.length, completed: runs.filter((r) => r.status === "COMPLETED").length, completion: rate(runs.filter((r) => r.status === "COMPLETED").length, runs.length, 1) } : { status: "insufficient_data", note: "No checklists were started in this range." },
    incidents: incidents.length ? { status: "ok", total: incidents.length, open: incidents.filter((i) => i.status !== "RESOLVED").length, byCategory: tally(incidents, "category"), bySeverity: tally(incidents, "severity") } : { status: "insufficient_data", note: "No incidents were recorded in this range." },
    campaigns, generatedAt: now.toISOString(),
  };
}

/** Pure: reports as CSV rows for export (managers only; the export is audited by the caller). */
export function reportsCsv(r) {
  const rows = [["metric", "key", "value"]];
  for (const [k, v] of Object.entries(r.reservations.byStatus)) rows.push(["reservations_by_status", k, v]);
  rows.push(["covers", "", r.reservations.covers]);
  for (const m of ["noShowRate", "cancellationRate", "repeatGuests", "waitlistConversion"]) rows.push([m, r[m].status, r[m].status === "ok" ? `${r[m].value}% (${r[m].numerator}/${r[m].denominator})` : `insufficient data (${r[m].denominator})`]);
  if (r.sourceMix.status === "ok") for (const [k, v] of Object.entries(r.sourceMix.bySource)) rows.push(["reservations_by_source", k, v]);
  if (r.wastage.status === "ok") for (const w of r.wastage.byIngredient) rows.push(["wastage", w.name, `${w.quantity} ${w.unit}`]);
  if (r.incidents.status === "ok") for (const [k, v] of Object.entries(r.incidents.byCategory)) rows.push(["incidents_by_category", k, v]);
  // Leading =, +, - or @ would be run as a formula by a spreadsheet: neutralise it.
  const cell = (x) => { const s = String(x ?? ""); const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

// ---- integration status (SOW 19): only what can be checked is called connected ----
export async function integrationStatus({ orgId, membership }) {
  if (!canAccessHospitality(membership)) return fail("You don't have access to the Hospitality workspace.", 403);
  const env = process.env;
  const emailConfigured = !!env.RESEND_API_KEY;
  const marketingConfigured = !!(env.MARKETING_EMAIL_FROM && (env.RESEND_MARKETING_API_KEY || env.RESEND_API_KEY));
  const webhook = !!env.RESEND_MARKETING_WEBHOOK_SECRET;
  let delivered = 0;
  try { const { engagementCollections } = await import("../engagement/store.js"); const { marketing } = await engagementCollections(); delivered = await marketing.countDocuments({ orgId: toObjectId(orgId), kind: "send", status: "delivered" }, { limit: 1 }); } catch { delivered = 0; }
  const sms = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
  return {
    statuses: ["connected_verified", "configured_not_verified", "available", "planned", "unsupported"],
    integrations: [
      { id: "email_transactional", category: "Email", name: "Reservation emails (confirmations, reminders)", status: emailConfigured ? "configured_not_verified" : "available", detail: emailConfigured ? "Emails are handed to the mail provider. Each reservation shows whether the provider accepted the message; that is not proof of delivery." : "No mail provider is configured on this server." },
      { id: "email_marketing", category: "Email", name: "Campaign email provider (Resend)", status: marketingConfigured && webhook && delivered ? "connected_verified" : marketingConfigured ? "configured_not_verified" : "available", detail: marketingConfigured && webhook && delivered ? "The provider has confirmed deliveries for this company through its webhook." : marketingConfigured ? "A sender is configured, but no delivery confirmation has come back through the provider webhook yet." : "The campaign sending domain hasn't been set up." },
      { id: "sms", category: "Messaging", name: "Text reminders (Twilio)", status: sms ? "configured_not_verified" : "available", detail: sms ? "Credentials are set; delivery isn't verified." : "Not configured. Reminders go by email only." },
      { id: "calendar_ics", category: "Calendar", name: "Calendar feed (ICS)", status: "available", detail: "Staff can subscribe to their calendar from Appointments. Two-way Google or Outlook sync isn't offered." },
      { id: "calendar_google", category: "Calendar", name: "Google Calendar / Outlook two-way sync", status: "planned", detail: "Not built. Sync direction, conflict ownership and cancellation behaviour have to be agreed first." },
      { id: "pos", category: "Point of sale", name: "POS sales and order events", status: "planned", detail: "No POS is connected. Until one is, stock isn't deducted from sales and food cost isn't calculated." },
      { id: "payments", category: "Payments", name: "Deposits and card payments", status: "planned", detail: "Not built. Card details are never stored." },
      { id: "accounting", category: "Accounting", name: "External accounting platforms", status: "planned", detail: "Supplier bills go to Finance and the AI Bookkeeper inside the workspace." },
      { id: "delivery_marketplaces", category: "Delivery", name: "Food-delivery marketplaces", status: "unsupported", detail: "Outside this product's scope." },
    ],
    webhooks: { note: "Workflow events raised by this workspace can be sent to your own systems from Settings > Webhooks." },
  };
}

export { oid };
