// app/api/orgs/metrics/[[...path]]/route.js -- privacy-safe metrics for one organization (Competitive Expansion SOW 43). Session + membership.
//   GET  ?orgId=&days=         counters from the fixed catalog plus live gauges (administrators and auditors)
//   POST client { orgId, events: [{ name, label?, value? }] }   client-reported counters (decrypt failures, reconnects, latency, preview failures); only the catalog's client metrics are accepted
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { slidingWindowCheck } from "../../../../../lib/rateLimit.js";
import { orgMetrics, record, CLIENT_METRICS } from "../../../../../lib/metrics/metrics.js";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const url = new URL(req.url); let body = {}; if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    if (path[0] === "client" && req.method === "POST") {
      const rl = await slidingWindowCheck({ action: "metrics:client", key: `${orgId}:${auth.session.email}`, max: 120, windowMs: 60_000 }); if (!rl.allowed) return json({ error: "Too many reports." }, 429);
      const events = Array.isArray(body.events) ? body.events.slice(0, 20) : []; let accepted = 0; for (const e of events) if (CLIENT_METRICS.includes(e?.name) && (await record(e.name, { orgId, label: e.label ?? null, value: e.value ?? 1 }))) accepted++;
      return json({ accepted, dropped: events.length - accepted });
    }
    if (!path.length && req.method === "GET") return json(await orgMetrics({ orgId, membership: auth.membership, days: url.searchParams.get("days") }));
    return json({ error: "Not found." }, 404);
  } catch (err) { if (err?.status === 403) return json({ error: err.message }, 403); console.error("orgs/metrics failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong." }, 500); }
}
export const GET = handle, POST = handle;
