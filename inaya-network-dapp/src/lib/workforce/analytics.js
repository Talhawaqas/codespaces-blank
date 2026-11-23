// src/lib/workforce/analytics.js -- Commerce Phase 6 (Master SOW 10.7 operational analytics, 10.8 AI operational assistant).
// Every figure is computed from source records (punches, shifts, POS sales, commission lines, checklist runs, incidents) and is
// branch-scoped to what the viewer may see. Labour cost is shown ONLY where an hourly cost exists on the employee record
// (employees.hourlyCost) and is labelled an estimate; otherwise it is left out (SOW: "Label estimates and exclude unavailable costs").
// The assistant only SUMMARISES and SUGGESTS: it never schedules, pays, disciplines or changes anyone's status.
import { getOrgCollections } from "../orgs.js";
import { ccol, oid, sid, fail, fromMinor } from "../commerce/store.js";
import { scopeFilter, allowedLocation, denyLocation } from "./scope.js";
import { computeTimesheet, getTimeSettings, isMgr } from "./time.js";

export async function workforceReport({ orgId, membership, from, to, locationId = null }) {
  if (!isMgr(membership)) return fail("Workforce reports are for managers.", 403);
  if (locationId && !allowedLocation(membership, locationId)) return denyLocation();
  const f = new Date(from || Date.now() - 7 * 86400000).toISOString(), t = new Date(to || Date.now()).toISOString();
  const scope = locationId ? { locationId: oid(locationId) } : scopeFilter(membership, "locationId");
  const c = await ccol(); const { salesOrders, warehouses, employees } = await getOrgCollections(); const settings = await getTimeSettings(orgId);
  const punches = await c.find({ orgId: oid(orgId), kind: "w_punch", at: { $gte: f, $lte: t }, ...scope }).toArray();
  const shifts = await c.find({ orgId: oid(orgId), kind: "w_shift", status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] }, start: { $gte: f, $lte: t }, ...scope }).toArray();
  const sales = await salesOrders.find({ orgId: oid(orgId), channel: "POS", status: { $ne: "VOIDED" }, completedAt: { $gte: f, $lte: t }, ...(locationId ? { warehouseId: oid(locationId) } : scopeFilter(membership, "warehouseId")) }, { projection: { cashierEmail: 1, attribution: 1, totals: 1, warehouseId: 1 } }).toArray(); for (const s of sales) s.total = (s.totals?.totalMinor || 0) / 100;
  const emails = [...new Set([...punches.map((p) => p.email), ...shifts.map((s) => s.email), ...sales.map((s) => s.cashierEmail).filter(Boolean)])];
  const costs = new Map((await employees.find({ orgId: oid(orgId), memberEmail: { $in: emails } }, { projection: { memberEmail: 1, hourlyCost: 1 } }).toArray()).filter((e) => Number(e.hourlyCost) > 0).map((e) => [e.memberEmail, Number(e.hourlyCost)]));
  const people = emails.map((e) => {
    const ts = computeTimesheet(punches.filter((p) => p.email === e), shifts.filter((s) => s.email === e), settings);
    const mySales = sales.filter((s) => (s.attribution?.length ? s.attribution.some((a) => a.email === e) : s.cashierEmail === e));
    const salesTotal = mySales.reduce((n, s) => n + (s.attribution?.length ? (s.total || 0) * (s.attribution.find((a) => a.email === e).share / 100) : s.total || 0), 0);
    const scheduled = ts.days.reduce((n, d) => n + d.scheduledHours, 0);
    return { email: e, workedHours: ts.totalHours, scheduledHours: Math.round(scheduled * 100) / 100, lateDays: ts.days.filter((d) => d.late).length, leftEarlyDays: ts.days.filter((d) => d.leftEarly).length, exceptions: ts.exceptions, sales: mySales.length, salesTotal: Math.round(salesTotal * 100) / 100, salesPerHour: ts.totalHours ? Math.round((salesTotal / ts.totalHours) * 100) / 100 : null, labourCostEstimate: costs.has(e) ? Math.round(costs.get(e) * ts.totalHours * 100) / 100 : null };
  });
  const ws = await warehouses.find({ orgId: oid(orgId) }, { projection: { name: 1 } }).toArray(); const wname = new Map(ws.map((w) => [sid(w._id), w.name]));
  const branches = [...new Set([...sales.map((s) => sid(s.warehouseId)), ...punches.map((p) => sid(p.locationId))])].filter(Boolean).map((b) => {
    const bs = sales.filter((s) => sid(s.warehouseId) === b); const bp = punches.filter((p) => sid(p.locationId) === b);
    const hrs = [...new Set(bp.map((p) => p.email))].reduce((n, e) => n + computeTimesheet(bp.filter((p) => p.email === e), [], settings).totalHours, 0);
    const total = bs.reduce((n, s) => n + (s.total || 0), 0); return { locationId: b, name: wname.get(b) || "Branch", sales: bs.length, salesTotal: Math.round(total * 100) / 100, labourHours: Math.round(hrs * 100) / 100, salesPerLabourHour: hrs ? Math.round((total / hrs) * 100) / 100 : null };
  });
  const runs = await c.find({ orgId: oid(orgId), kind: "w_check_run", date: { $gte: f.slice(0, 10), $lte: t.slice(0, 10) }, ...scope }).toArray();
  const incidents = await c.countDocuments({ orgId: oid(orgId), kind: "w_incident", status: "OPEN", ...scope });
  const labourKnown = people.every((p) => p.labourCostEstimate !== null);
  return { from: f, to: t, people: people.sort((a, b) => b.salesTotal - a.salesTotal), branches,
    totals: { workedHours: Math.round(people.reduce((n, p) => n + p.workedHours, 0) * 100) / 100, scheduledHours: Math.round(people.reduce((n, p) => n + p.scheduledHours, 0) * 100) / 100, lateArrivals: people.reduce((n, p) => n + p.lateDays, 0), exceptions: people.reduce((n, p) => n + p.exceptions.length, 0), checklistsSignedOff: runs.filter((r) => r.signedOffAt).length, checklistsStarted: runs.length, openIncidents: incidents,
      labourCostEstimate: people.some((p) => p.labourCostEstimate !== null) ? Math.round(people.reduce((n, p) => n + (p.labourCostEstimate || 0), 0) * 100) / 100 : null, labourCostComplete: labourKnown },
    notes: labourKnown ? ["Labour cost is an ESTIMATE from hourly costs on employee records."] : ["Labour cost is shown only for people with an hourly cost on their employee record; it is an estimate and is incomplete."] };
}

/** Daily branch summary and suggestions -- advisory only. */
export async function operationsBrief({ orgId, membership, locationId, date }) {
  if (!isMgr(membership)) return fail("The operations brief is for managers.", 403); if (!allowedLocation(membership, locationId)) return denyLocation();
  const day = String(date || new Date().toISOString().slice(0, 10));
  const rep = await workforceReport({ orgId, membership, from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z`, locationId });
  const { branchChecklists } = await import("./commissions.js"); const cl = await branchChecklists({ orgId, membership, locationId, date: day });
  const { rota } = await import("./time.js"); const wk = new Date(`${day}T00:00:00Z`); const r = await rota({ orgId, membership, locationId, weekStart: wk.toISOString() });
  const b = rep.branches[0] || { salesTotal: 0, sales: 0, labourHours: 0 };
  const lines = [`${b.sales} sales worth ${b.salesTotal.toFixed(2)} with ${b.labourHours} staff hours${b.salesPerLabourHour ? ` (${b.salesPerLabourHour.toFixed(2)} per labour hour)` : ""}.`];
  const overdue = cl.checklists.filter((x) => x.state === "OVERDUE"); if (overdue.length) lines.push(`Overdue checklists: ${overdue.map((x) => x.name).join(", ")}.`);
  const late = rep.people.filter((p) => p.lateDays); if (late.length) lines.push(`Late arrivals: ${late.map((p) => p.email).join(", ")}.`);
  const exc = rep.people.flatMap((p) => p.exceptions.map((e) => `${p.email}: ${e.kind.replace(/_/g, " ").toLowerCase()}`)); if (exc.length) lines.push(`Attendance exceptions: ${exc.join("; ")}.`);
  const under = r.coverage.filter((x) => x.date === day && x.state === "UNDERSTAFFED"); if (under.length) lines.push(`Understaffed: ${under.map((x) => `${x.fromHour}:00-${x.toHour}:00 (${x.staffed}/${x.needed})`).join(", ")}.`);
  const suggestions = [];
  if (under.length) suggestions.push("Consider adding a shift or asking available staff to cover the understaffed hours (a manager decides).");
  if (overdue.length) suggestions.push("Ask the shift lead to complete and sign off the overdue checklists.");
  if (exc.some((e) => /still clocked in|missing clock out/.test(e))) suggestions.push("Someone may have forgotten to clock out; review and approve a correction if needed.");
  if (rep.totals.openIncidents) suggestions.push(`${rep.totals.openIncidents} incident(s) are still open.`);
  return { date: day, summary: lines, suggestions, advisoryOnly: true, draftMessage: `Hi team, quick update for ${day}: ${lines.join(" ")}${suggestions.length ? ` Next: ${suggestions[0]}` : ""}` };
}
export { fromMinor };
