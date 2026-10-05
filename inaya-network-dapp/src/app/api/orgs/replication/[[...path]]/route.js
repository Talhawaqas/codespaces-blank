// app/api/orgs/replication/[[...path]]/route.js -- site replication and failover readiness (Competitive Expansion SOW O). Session + membership; no feature flag
// (it only reads replica records the backup engine already keeps, and changes no data).
//   GET  profile      PUT profile { primary, secondaries[], targets: { rtoMinutes, rpoMinutes } }
//   GET  state        measured replication state, RPO exposure, failover readiness
//   POST tests { secondary, sample? }   run a recovery test against a secondary (reads a sample back and verifies it)
//   GET  evidence     downloadable evidence package (JSON) with a hash
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import * as H from "../../../../../lib/ha/replication.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200, h = {}) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", ...h } });
async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const url = new URL(req.url); let body = {}; if (method === "PUT" || method === "POST") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const base = { orgId, membership: auth.membership, actorEmail: auth.session.email }; const [a] = path;
    if (a === "profile") return json(method === "PUT" ? await H.setProfile({ ...base, primary: body.primary, secondaries: body.secondaries, targets: body.targets }) : await H.getProfile(base));
    if (a === "state" && method === "GET") return json(await H.measure(base));
    if (a === "tests" && method === "POST") return json(await H.runRecoveryTest({ ...base, secondary: body.secondary, sample: body.sample }), 201);
    if (a === "evidence" && method === "GET") { const pkg = await H.evidencePackage(base); return json(pkg, 200, { "Content-Disposition": `attachment; filename="replication-evidence-${pkg.generatedAt.slice(0, 10)}.json"` }); }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof H.HaError) return json({ error: err.message }, err.status);
    console.error("orgs/replication failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle, PUT = handle, POST = handle;
