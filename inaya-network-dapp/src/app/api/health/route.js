// app/api/health/route.js
//
// GET /api/health — public, DB-free liveness check. Exists specifically
// as a canary target for an edge/CDN layer (Cloudflare health checks,
// load-balancer probes) that needs a cheap, always-200, no-auth endpoint
// to confirm the origin is reachable — no such route existed before this
// (every other status-shaped route either requires auth or hits MongoDB).
//
// GET /api/health?deep=1 — also pings the database (the uptime monitor,
// .github/workflows/uptime-check.yml). Every Business Workspace screen
// depends on it, and a database outage is invisible to the plain check
// (2026-10-24: every API failed while this route still answered 200).
// Answers 503 when the ping fails or takes over 8 seconds (a cold start opens a new connection, which alone can take 4 to 5 seconds), and only ever
// says ok/fail plus a round-trip time: no hosts, counts or error text.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  if (!deep) {
    return NextResponse.json({ status: "ok", timestamp: new Date().toISOString() }, { headers: NO_STORE });
  }

  const started = Date.now();
  try {
    const { connectToDatabase } = await import("../../../lib/mongodb.js");
    const ping = connectToDatabase().then(({ db }) => db.command({ ping: 1 }));
    await Promise.race([ping, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
    return NextResponse.json(
      { status: "ok", database: "ok", databaseMs: Date.now() - started, timestamp: new Date().toISOString() },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "unreachable", timestamp: new Date().toISOString() },
      { status: 503, headers: NO_STORE }
    );
  }
}
