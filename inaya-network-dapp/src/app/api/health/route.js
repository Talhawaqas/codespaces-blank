// app/api/health/route.js
//
// GET /api/health — public, DB-free liveness check. Exists specifically
// as a canary target for an edge/CDN layer (Cloudflare health checks,
// load-balancer probes) that needs a cheap, always-200, no-auth endpoint
// to confirm the origin is reachable — no such route existed before this
// (every other status-shaped route either requires auth or hits MongoDB).

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
