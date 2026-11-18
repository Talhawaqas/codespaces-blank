// app/api/orgs/exports/route.js -- company data export jobs (License Manager SOW 12.4). Owner/Admin only.
//   GET  /api/orgs/exports?orgId=   -> recent export jobs and their status
//   POST /api/orgs/exports?orgId=   -> request a new export (one at a time, a few a day); built in the background
// Open while the license is restricted (licensing/gate.js), so a suspended company can always take its data.
import { NextResponse, after } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { ExportError, listExports, processExportJob, requestExport } from "../../../../lib/licensing/exports.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function guard(req) {
  const orgId = new URL(req.url).searchParams.get("orgId");
  if (!orgId) return { res: NextResponse.json({ error: "orgId is required." }, { status: 400 }) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId, { requireManage: true });
  if (auth.error) return { res: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  return { orgId, auth };
}

export async function GET(req) {
  try {
    const g = await guard(req); if (g.res) return g.res;
    return NextResponse.json({ exports: await listExports(g.orgId) });
  } catch (err) {
    console.error("orgs/exports GET failed:", err?.message);
    return NextResponse.json({ error: "Could not load exports." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const g = await guard(req); if (g.res) return g.res;
    const { job, existing } = await requestExport({ orgId: g.orgId, email: g.auth.session.email });
    // Build it right after responding; the hourly license job picks up anything that did not finish.
    if (!existing) after(() => processExportJob(job.id).catch((e) => console.error("export build failed:", e?.message)));
    return NextResponse.json({ export: job, existing: !!existing }, { status: existing ? 200 : 202 });
  } catch (err) {
    if (err instanceof ExportError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("orgs/exports POST failed:", err?.message);
    return NextResponse.json({ error: "Could not start the export." }, { status: 500 });
  }
}
