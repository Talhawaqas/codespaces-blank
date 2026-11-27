// app/api/orgs/payroll/[[...path]]/route.js -- Payroll (src/lib/payroll/*). Session + membership; role checks and the
// package gate live in the library. Employees reach only the "my" routes (their own published payslips).
//
//   GET presets                                  GET|PUT settings      POST settings/confirm
//   GET employees                                GET|PUT employees/{employeeId}/profile     GET employees/{employeeId}/gratuity?lastDay
//   GET|POST loans (?employeeId)
//   GET|POST runs { period, adjustments }        GET runs/{id}         POST runs/{id}/recalc { adjustments }
//   POST runs/{id}/{submit|approve|reopen|cancel|pay} { reason }      GET runs/{id}/bank-file?format=csv|wps
//   POST runs/{id}/deliver { channels: ["email","whatsapp"] }
//   GET my/payslips     PUT my/options { payslipPassword, whatsapp }   GET payslips/{id}   GET payslips/{id}/pdf
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import * as P from "../../../../../lib/payroll/store.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r, ok));

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const q = Object.fromEntries(new URL(req.url).searchParams.entries()); let body = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const membership = auth.membership, actorEmail = auth.session.email; const base = { orgId, membership, actorEmail }; const [a, b, c] = path;

    if (a === "my" && b === "payslips" && method === "GET") return out(await P.myPayslips(base));
    if (a === "my" && b === "options" && method === "PUT") return out(await P.setMyPayslipOptions({ ...base, input: body }));
    if (a === "payslips" && b && !c && method === "GET") return out(await P.getPayslip({ ...base, slipId: b }));
    if (a === "payslips" && b && c === "pdf" && method === "GET") {
      const r = await P.payslipDownload({ ...base, slipId: b }); if (r.error) return out(r);
      return new NextResponse(r.buffer, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${r.filename}"`, "Cache-Control": "no-store" } });
    }

    // Everything below is payroll administration: the package must include Payroll.
    const ent = await P.entitled(orgId); if (ent.error) return out(ent);
    if (a === "presets" && method === "GET") return json({ presets: P.presetInfo() });
    if (a === "settings" && !b) { if (method === "GET") return json({ settings: await P.getSettings(orgId) }); if (method === "PUT") return out(await P.saveSettings({ ...base, input: body })); }
    if (a === "settings" && b === "confirm" && method === "POST") return out(await P.confirmPreset(base));
    if (a === "employees" && !b && method === "GET") return out(await P.listProfiles(base));
    if (a === "employees" && b && c === "profile") { if (method === "GET") return out(await P.getProfile({ ...base, employeeId: b })); if (method === "PUT") return out(await P.saveProfile({ ...base, employeeId: b, input: body })); }
    if (a === "employees" && b && c === "gratuity" && method === "GET") return out(await P.gratuityEstimate({ ...base, employeeId: b, lastDay: q.lastDay }));
    if (a === "loans") { if (method === "GET") return out(await P.listLoans({ ...base, employeeId: q.employeeId })); if (method === "POST") return out(await P.createLoan({ ...base, employeeId: body.employeeId, input: body }), 201); }
    if (a === "runs" && !b) { if (method === "GET") return out(await P.listRuns(base)); if (method === "POST") return out(await P.createRun({ ...base, period: body.period, adjustments: body.adjustments }), 201); }
    if (a === "runs" && b) {
      if (!c && method === "GET") return out(await P.getRun({ ...base, runId: b }));
      if (c === "recalc" && method === "POST") return out(await P.recalcRun({ ...base, runId: b, adjustments: body.adjustments }));
      if (["submit", "approve", "reopen", "cancel", "pay"].includes(c) && method === "POST") return out(await P.transitionRun({ ...base, runId: b, action: c, reason: body.reason }));
      if (c === "deliver" && method === "POST") return out(await P.deliverRun({ ...base, runId: b, channels: Array.isArray(body.channels) ? body.channels.filter((x) => ["email", "whatsapp"].includes(x)) : ["email"] }));
      if (c === "bank-file" && method === "GET") {
        const r = await P.bankFile({ ...base, runId: b, format: q.format === "wps" ? "wps" : "csv" }); if (r.error) return out(r);
        return new NextResponse(r.content, { status: 200, headers: { "Content-Type": r.contentType, "Content-Disposition": `attachment; filename="${r.filename}"`, "Cache-Control": "no-store" } });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("orgs/payroll failed:", err?.message);
    return json({ error: "Payroll request failed." }, 500);
  }
}
export const GET = handle; export const POST = handle; export const PUT = handle;
