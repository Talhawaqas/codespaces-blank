// app/api/orgs/ops/[[...path]]/route.js -- Manage Orders SOW (Work Orders, Repair Orders, scheduler, technician job
// activity, exceptions, preventive maintenance, Purchase Order register, cheques, reports). Session + membership first;
// entitlement, role, branch and assignment checks live in src/lib/ops/*. Used by the web app and the Inaya mobile app.
//   GET  me | day | settings | jobs?type&status&warehouseId&assignee&priority&q&from&to&sort | jobs/{id} | board?from&to&warehouseId
//   GET  technicians | technicians/report?email&from&to | assets?contactId&q | assets/{id}/history | exceptions?status | sites | pm
//   GET  pos?q&status&supplierId&from&to | dashboard?warehouseId&from&to | jobs/{id}/suggest | files/{id}
//   GET  cheques?status&q&from&to&bookId | cheques/books | cheques/templates | cheques/report | cheques/{id}/reconcile (suggestions)
//   POST jobs | jobs/{id}/{transition} {action, reason} | jobs/{id}/activity {type,...} | jobs/{id}/notes | jobs/{id}/checklist
//   POST jobs/{id}/parts | jobs/{id}/parts/{partId} {action, quantity, idempotencyKey} | jobs/{id}/assign | jobs/{id}/unassign
//   POST jobs/{id}/reschedule | jobs/{id}/po {purchaseOrderId, unlink} | jobs/{id}/estimates | jobs/{id}/estimates/{eid}/decision
//   POST jobs/{id}/diagnosis | jobs/{id}/intake-ack | jobs/{id}/completion | jobs/{id}/invoice | jobs/{id}/evidence (raw bytes,
//        ?filename&caption&checklistItemId) | jobs/{id}/labour-correction | assets | assets/{id} | technicians/{email} | roles
//   POST exceptions/{id} {action, reason} | exceptions/{id}/explain | sites | pm | pm/{id} | settings
//   POST cheques | cheques/{id} (edit) | cheques/{id}/decision | cheques/{id}/print {kind, reason, idempotencyKey} | cheques/test-print
//   POST cheques/{id}/spoil | cheques/{id}/issue | cheques/{id}/void {reason, returned} | cheques/{id}/reconcile {bankTransactionId}
//   POST cheques/books | cheques/templates | cheques/templates/{id}
//   PATCH jobs/{id} (edit)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { slidingWindowCheck } from "../../../../../lib/rateLimit.js";
import * as C from "../../../../../lib/ops/core.js";
import * as J from "../../../../../lib/ops/jobs.js";
import * as S from "../../../../../lib/ops/scheduler.js";
import * as A from "../../../../../lib/ops/activity.js";
import * as P from "../../../../../lib/ops/pm.js";
import * as Q from "../../../../../lib/ops/cheques.js";
import * as R from "../../../../../lib/ops/registers.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.problems ? { problems: r.problems } : {}) }, r.status || 400) : json(r));
async function ctx(req, orgId) {
  if (!orgId || !/^[0-9a-f]{24}$/i.test(orgId)) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { membership: { ...auth.membership, email: auth.session.email }, actorEmail: auth.session.email };
}
async function limited(key, max, windowMs) {
  try { const r = await slidingWindowCheck({ action: "manage-orders", key, max, windowMs }); return r?.allowed === false || r?.limited === true; } catch { return false; }
}

export async function GET(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams; const q = (k) => qs.get(k) || undefined; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership };
    if (path === "me") { const entitled = await C.opsEntitled(orgId); return json({ entitled, email: c.actorEmail, role: C.opsRoleOf(c.membership), can: Object.fromEntries(["view_all", "create_wo", "create_ro", "edit_job", "schedule", "approve", "parts", "estimate", "costs", "exceptions", "settings", "work"].map((k) => [k, C.can(c.membership, k)])), finance: !(await C.opsAccess({ ...b, need: "finance" })), financeManager: !(await C.opsAccess({ ...b, need: "finance_manage" })) }); }
    if (path === "day") return out(await A.myDay(b));
    if (path === "settings") { const d = await C.opsAccess({ ...b, need: "view_all" }); if (d) return out(d); return json({ settings: await C.getOpsSettings(orgId) }); }
    if (path === "jobs") return out(await J.listJobs({ ...b, type: q("type"), status: q("status"), warehouseId: q("warehouseId"), assignee: q("assignee"), priority: q("priority"), q: q("q"), from: q("from"), to: q("to"), sort: q("sort"), limit: q("limit"), skip: q("skip") }));
    if (seg[0] === "jobs" && seg[1] && !seg[2]) return out(await J.getJob({ ...b, jobId: seg[1] }));
    if (seg[0] === "jobs" && seg[2] === "suggest") return out(await S.suggestTechnicians({ ...b, jobId: seg[1] }));
    if (path === "lookups") return out(await R.lookups({ ...b, kind: q("kind"), q: q("q") }));
    if (path === "board") return out(await S.board({ ...b, from: q("from"), to: q("to"), warehouseId: q("warehouseId") }));
    if (path === "technicians") return out(await S.listTechnicians(b));
    if (path === "technicians/report") return out(await R.technicianReport({ ...b, email: q("email"), from: q("from"), to: q("to") }));
    if (path === "assets") return out(await J.listAssets({ ...b, contactId: q("contactId"), q: q("q") }));
    if (seg[0] === "assets" && seg[2] === "history") return out(await J.assetHistory({ ...b, assetId: seg[1] }));
    if (path === "exceptions") return out(await A.listExceptions({ ...b, status: q("status") || "OPEN" }));
    if (path === "sites") return out(await A.listSites(b));
    if (path === "pm") return out(await P.listPmTemplates(b));
    if (path === "pos") return out(await R.poRegister({ ...b, q: q("q"), status: q("status"), supplierId: q("supplierId"), from: q("from"), to: q("to"), limit: q("limit"), skip: q("skip") }));
    if (path === "dashboard") return out(await R.opsDashboard({ ...b, warehouseId: q("warehouseId"), from: q("from"), to: q("to") }));
    if (seg[0] === "files" && seg[1]) {
      const r = await A.downloadEvidence({ ...b, actorEmail: c.actorEmail, fileId: seg[1] }); if (r.error) return out(r);
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(r.contentType);
      return new NextResponse(r.buffer, { headers: { "Content-Type": r.contentType, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${r.filename.replace(/["\\]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; img-src 'self'" } });
    }
    if (path === "cheques") return out(await Q.listCheques({ ...b, status: q("status"), q: q("q"), from: q("from"), to: q("to"), bookId: q("bookId") }));
    if (path === "cheques/books") return out(await Q.listBooks(b));
    if (path === "cheques/templates") return out(await Q.listTemplates(b));
    if (path === "cheques/report") return out(await Q.chequeReport(b));
    if (seg[0] === "cheques" && seg[2] === "reconcile") return out(await Q.reconcileCheque({ ...b, actorEmail: c.actorEmail, id: seg[1], suggestOnly: true }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("ops GET failed:", path, e?.message); return json({ error: "Something went wrong. Please try again." }, 500); }
}

export async function POST(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams;
    // Evidence is sent as raw bytes (the mobile app and the browser both send the file body directly, at most 4 MB).
    if (seg[0] === "jobs" && seg[2] === "evidence") {
      const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
      if (await limited(`ops-evidence:${c.actorEmail}`, 60, 3600000)) return json({ error: "Too many uploads; try again later." }, 429);
      const len = Number(req.headers.get("content-length") || 0); if (len > 4 * 1024 * 1024 + 1024) return json({ error: "Files must be 4 MB or smaller." }, 413);
      const buffer = Buffer.from(await req.arrayBuffer());
      return out(await A.uploadEvidence({ orgId, membership: c.membership, actorEmail: c.actorEmail, jobId: seg[1], filename: qs.get("filename"), buffer, caption: qs.get("caption"), checklistItemId: qs.get("checklistItemId") }));
    }
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const orgId = body.orgId || qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    if (await limited(`ops:${c.actorEmail}`, 600, 3600000)) return json({ error: "Too many requests; slow down a little." }, 429);
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (path === "push/register") return out(await C.registerPushToken({ orgId, membership: c.membership, token: body.token, platform: body.platform }));
    if (path === "push/unregister") return out(await C.registerPushToken({ orgId, membership: c.membership, token: body.token, unregister: true }));
    if (path === "jobs") return out(await J.createJob({ ...b, input: body }));
    if (seg[0] === "jobs" && seg[1]) {
      const jobId = seg[1]; const sub = seg.slice(2).join("/");
      if (sub === "transition") return out(await J.transitionJob({ ...b, jobId, action: body.action, reason: body.reason }));
      if (sub === "activity") return out(await A.recordActivity({ ...b, jobId, input: body }));
      if (sub === "notes") return out(await J.addNote({ ...b, jobId, text: body.text, internal: body.internal }));
      if (sub === "checklist") return out(await J.tickChecklist({ ...b, jobId, itemId: body.itemId, done: body.done, note: body.note }));
      if (sub === "parts") return out(await J.addPart({ ...b, jobId, productId: body.productId, quantity: body.quantity, unitPrice: body.unitPrice, request: body.request }));
      if (seg[2] === "parts" && seg[3]) return out(await J.partAction({ ...b, jobId, partId: seg[3], action: body.action, quantity: body.quantity, idempotencyKey: body.idempotencyKey }));
      if (sub === "assign") return out(await S.assignTechnician({ ...b, jobId, email: body.email, lead: body.lead !== false, start: body.start, end: body.end, override: body.override }));
      if (sub === "unassign") return out(await S.unassignTechnician({ ...b, jobId, email: body.email, reason: body.reason }));
      if (sub === "reschedule") return out(await S.rescheduleJob({ ...b, jobId, start: body.start, end: body.end, reason: body.reason, override: body.override }));
      if (sub === "po") return out(await J.linkPurchaseOrder({ ...b, jobId, purchaseOrderId: body.purchaseOrderId, unlink: !!body.unlink }));
      if (sub === "estimates") return out(await J.createEstimate({ ...b, jobId, input: body }));
      if (seg[2] === "estimates" && seg[4] === "decision") return out(await J.decideEstimate({ ...b, jobId, estimateId: seg[3], decision: body.decision, customerName: body.customerName, method: body.method, note: body.note }));
      if (sub === "diagnosis") return out(await J.recordDiagnosis({ ...b, jobId, input: body }));
      if (sub === "intake-ack") return out(await J.recordIntakeAck({ ...b, jobId, customerName: body.customerName, method: body.method }));
      if (sub === "completion") return out(await J.recordCompletion({ ...b, jobId, input: body }));
      if (sub === "invoice") return out(await J.invoiceRepair({ ...b, jobId, departmentId: body.departmentId }));
      if (sub === "labour-correction") return out(await A.requestLabourCorrection({ ...b, jobId, minutesDelta: body.minutesDelta, reason: body.reason }));
    }
    if (path === "assets") return out(await J.saveAsset({ ...b, input: body }));
    if (seg[0] === "assets" && seg[1]) return out(await J.saveAsset({ ...b, assetId: seg[1], input: body }));
    if (seg[0] === "technicians" && seg[1]) return out(await S.saveTechnician({ ...b, email: decodeURIComponent(seg[1]), input: body }));
    if (path === "roles") return out(await S.setOpsRole({ ...b, email: body.email, opsRole: body.opsRole ?? null }));
    if (seg[0] === "exceptions" && seg[1] && seg[2] === "explain") return out(await A.explainException({ ...b, id: seg[1], text: body.text }));
    if (seg[0] === "exceptions" && seg[1] === "scan") { const d = await C.opsAccess({ ...b, need: "exceptions" }); if (d) return out(d); return out(await A.scanExceptions(orgId)); }
    if (seg[0] === "exceptions" && seg[1]) return out(await A.resolveException({ ...b, id: seg[1], action: body.action, reason: body.reason }));
    if (path === "sites") return out(await A.saveSite({ ...b, input: body }));
    if (path === "pm") return out(await P.savePmTemplate({ ...b, input: body }));
    if (seg[0] === "pm" && seg[1]) return out(await P.savePmTemplate({ ...b, id: seg[1], input: body }));
    if (path === "settings") return out(await C.setOpsSettings({ ...b, input: body }));
    if (path === "cheques") return out(await Q.createCheque({ ...b, input: body }));
    if (path === "cheques/books") return out(await Q.saveBook({ ...b, input: body }));
    if (path === "cheques/templates") return out(await Q.saveTemplate({ ...b, input: body }));
    if (seg[0] === "cheques" && seg[1] === "templates" && seg[2]) return out(await Q.saveTemplate({ ...b, id: seg[2], input: body }));
    if (path === "cheques/test-print") return out(await Q.printCheque({ ...b, kind: "test", templateId: body.templateId }));
    if (seg[0] === "cheques" && seg[1]) {
      const id = seg[1]; const sub = seg[2] || "";
      if (!sub) return out(await Q.editCheque({ ...b, id, input: body }));
      if (sub === "decision") return out(await Q.decideCheque({ ...b, id, approve: body.approve === true, reason: body.reason }));
      if (sub === "print") return out(await Q.printCheque({ ...b, id, kind: body.kind === "reprint" ? "reprint" : "print", reason: body.reason, idempotencyKey: body.idempotencyKey }));
      if (sub === "spoil") return out(await Q.spoilAndRenumber({ ...b, id, reason: body.reason }));
      if (sub === "issue") return out(await Q.issueCheque({ ...b, id }));
      if (sub === "void") return out(await Q.voidCheque({ ...b, id, reason: body.reason, returned: !!body.returned }));
      if (sub === "reconcile") return out(await Q.reconcileCheque({ ...b, id, bankTransactionId: body.bankTransactionId }));
    }
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("ops POST failed:", path, e?.message); return json({ error: "Something went wrong. Please try again." }, 500); }
}

export async function PATCH(req, { params }) {
  params = await params; const seg = params.path || [];
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const c = await ctx(req, body.orgId); if (c.error) return c.error;
    if (seg[0] === "jobs" && seg[1]) return out(await J.updateJob({ orgId: body.orgId, membership: c.membership, actorEmail: c.actorEmail, jobId: seg[1], input: body }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("ops PATCH failed:", e?.message); return json({ error: "Something went wrong. Please try again." }, 500); }
}
