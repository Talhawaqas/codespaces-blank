// app/api/orgs/workforce/[[...path]]/route.js -- Commerce Phase 6 (Master SOW section 10): branch scoping, user administration,
// attendance, rotas, commissions, checklists, incidents, workforce reports and the operations brief. Session + membership first;
// branch and role checks live in src/lib/workforce/*.
//   GET  me/locations   GET users   PUT users { email, template?, role?, commerceRole?, financeRole?, hrRole?, departmentIds?, locationIds?, defaultLocationId?, status? }
//   GET  time/status   POST time/punch { type, locationId, idempotencyKey }   GET time/sheet?email&from&to   GET time/export?from&to (CSV)
//   GET  time/settings  PUT time/settings   GET time/corrections?status   POST time/corrections   POST time/corrections/{id}/{approve|reject}
//   GET  rota?locationId&weekStart   POST rota/shifts   POST rota/shifts/{id}/{ack|cancel}   POST rota/publish   POST rota/templates   POST rota/needs
//   POST rota/availability   POST rota/swaps   POST rota/swaps/{id}/{approve|reject}   GET rota/export (CSV)
//   GET  commissions/rules   POST commissions/rules   GET commissions?month   POST commissions/accrue { from, to }   POST commissions/approve { month }
//   GET  commissions/export?month (CSV)   POST sales/{id}/attribution { attribution, reason }   POST tips { locationId, date, amount }
//   GET  checklists?locationId&date   POST checklists/templates   POST checklists/tick   GET incidents   POST incidents   POST incidents/{id}/resolve
//   GET  reports?from&to&locationId   GET brief?locationId&date
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import * as S from "../../../../../lib/workforce/scope.js";
import * as T from "../../../../../lib/workforce/time.js";
import * as C from "../../../../../lib/workforce/commissions.js";
import * as A from "../../../../../lib/workforce/analytics.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));
const csv = (r, name) => (r?.error ? out(r) : new NextResponse(r.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } }));
async function ctx(req, orgId) {
  if (!orgId) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { membership: auth.membership, actorEmail: auth.session.email };
}

export async function GET(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams; const q = (k) => qs.get(k) || undefined; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership };
    if (path === "me/locations") return out(await S.myLocations(b));
    if (path === "users") return out(await S.listUsers(b));
    if (path === "time/status") return out(await T.myStatus(b));
    if (path === "time/sheet") return out(await T.timesheet({ ...b, email: q("email"), from: q("from"), to: q("to") }));
    if (path === "time/export") return csv(await T.payrollExport({ ...b, from: q("from"), to: q("to") }), `timesheets-${q("from")?.slice(0, 10) || "range"}.csv`);
    if (path === "time/settings") return json({ settings: await T.getTimeSettings(orgId) });
    if (path === "time/corrections") return out(await T.listCorrections({ ...b, status: qs.has("status") ? q("status") || null : "PENDING" }));
    if (path === "rota") return out(await T.rota({ ...b, locationId: q("locationId"), weekStart: q("weekStart") }));
    if (path === "rota/export") return csv(await T.rotaCsv({ ...b, locationId: q("locationId"), weekStart: q("weekStart") }), "rota.csv");
    if (path === "commissions/rules") return out(await C.listRules(b));
    if (path === "commissions") return out(await C.commissionSummary({ ...b, month: q("month") }));
    if (path === "commissions/export") return csv(await C.exportPeriod({ ...b, month: q("month") }), `commissions-${q("month")}.csv`);
    if (path === "checklists") return out(await C.branchChecklists({ ...b, locationId: q("locationId"), date: q("date") }));
    if (path === "incidents") return out(await C.listIncidents({ ...b, status: q("status") || null }));
    if (path === "reports") return out(await A.workforceReport({ ...b, from: q("from"), to: q("to"), locationId: q("locationId") || null }));
    if (path === "brief") return out(await A.operationsBrief({ ...b, locationId: q("locationId"), date: q("date") }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("workforce GET failed:", e); return json({ error: "Something went wrong." }, 500); }
}

export async function POST(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const body = await req.json().catch(() => ({})); const orgId = body.orgId || new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (path === "time/punch") return out(await T.punch({ ...b, type: body.type, locationId: body.locationId, idempotencyKey: body.idempotencyKey, note: body.note, device: (req.headers.get("user-agent") || "").split(")")[0].slice(0, 120) }));
    if (path === "time/corrections") return out(await T.requestCorrection({ ...b, input: body }));
    if (seg[0] === "time" && seg[1] === "corrections" && seg[2] && ["approve", "reject"].includes(seg[3])) return out(await T.decideCorrection({ ...b, id: seg[2], approve: seg[3] === "approve", note: body.note }));
    if (path === "rota/shifts") return out(await T.saveShift({ ...b, input: body }));
    if (seg[0] === "rota" && seg[1] === "shifts" && seg[2] && seg[3] === "ack") return out(await T.acknowledgeShift({ ...b, id: seg[2] }));
    if (seg[0] === "rota" && seg[1] === "shifts" && seg[2] && seg[3] === "cancel") return out(await T.cancelShift({ ...b, id: seg[2], reason: body.reason }));
    if (path === "rota/publish") return out(await T.publishWeek({ ...b, locationId: body.locationId, weekStart: body.weekStart }));
    if (path === "rota/templates") return out(await T.saveTemplate({ ...b, input: body }));
    if (path === "rota/needs") return out(await T.setNeed({ ...b, input: body }));
    if (path === "rota/availability") return out(await T.setAvailability({ ...b, input: body }));
    if (path === "rota/swaps") return out(await T.requestSwap({ ...b, input: body }));
    if (seg[0] === "rota" && seg[1] === "swaps" && seg[2] && ["approve", "reject"].includes(seg[3])) return out(await T.decideSwap({ ...b, id: seg[2], approve: seg[3] === "approve" }));
    if (path === "commissions/rules") return out(await C.saveRule({ ...b, input: body }));
    if (path === "commissions/accrue") { if (!T.isMgr(c.membership)) return json({ error: "Managers only." }, 403); return out(await C.accrueRange({ orgId, from: body.from, to: body.to })); }
    if (path === "commissions/approve") return out(await C.approvePeriod({ ...b, month: body.month }));
    if (seg[0] === "sales" && seg[1] && seg[2] === "attribution") return out(await C.setAttribution({ ...b, saleId: seg[1], attribution: body.attribution, reason: body.reason }));
    if (path === "tips") return out(await C.allocateTips({ ...b, locationId: body.locationId, date: body.date, amount: body.amount }));
    if (path === "checklists/templates") return out(await C.saveChecklist({ ...b, input: body }));
    if (path === "checklists/tick") return out(await C.tickChecklist({ ...b, templateId: body.templateId, locationId: body.locationId, date: body.date, ticks: body.ticks, notes: body.notes, evidence: body.evidence, signOff: body.signOff === true }));
    if (path === "incidents") return out(await C.reportIncident({ ...b, input: body }));
    if (seg[0] === "incidents" && seg[1] && seg[2] === "resolve") return out(await C.resolveIncident({ ...b, id: seg[1], resolution: body.resolution }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("workforce POST failed:", e); return json({ error: "Something went wrong." }, 500); }
}

export async function PUT(req, { params }) {
  params = await params; const path = (params.path || []).join("/");
  try {
    const body = await req.json().catch(() => ({})); const orgId = body.orgId; const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (path === "users") return out(await S.updateUser({ ...b, email: body.email, input: body }));
    if (path === "time/settings") return out(await T.setTimeSettings({ ...b, input: body }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("workforce PUT failed:", e); return json({ error: "Something went wrong." }, 500); }
}
