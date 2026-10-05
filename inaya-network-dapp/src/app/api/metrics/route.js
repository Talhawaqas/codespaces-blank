// GET /api/metrics -- platform-wide Prometheus metrics for operators. Requires `Authorization: Bearer $METRICS_TOKEN` (at least 16 characters); with no token configured the route does not exist (404).
// Aggregates across organizations and carries no organization id, e-mail or free-text label.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../lib/orgs.js";
import { platformPrometheus, metricsTokenOk } from "../../../lib/metrics/metrics.js";
export const dynamic = "force-dynamic";
export async function GET(req) {
  if (!process.env.METRICS_TOKEN) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!metricsTokenOk(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  try { await ensureOrgIndexes(); return new NextResponse(await platformPrometheus({ days: Number(new URL(req.url).searchParams.get("days")) || 1 }), { status: 200, headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } }); }
  catch (err) { console.error("metrics failed:", err?.name); return NextResponse.json({ error: "Metrics unavailable." }, { status: 500 }); }
}
