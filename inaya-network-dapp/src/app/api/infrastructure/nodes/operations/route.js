// Node-facing: a node polls for its own pending operations, authenticated
// by its certificate-signed token (same scheme as heartbeat).
import { NextResponse } from "next/server";
import { claimPendingOperations, InfrastructureError } from "../../../../../lib/infrastructure/operations.js";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const operations = await claimPendingOperations({ signedToken: body.signedToken });
    return NextResponse.json({ operations }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof InfrastructureError) {
      return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
    }
    console.error("operation poll failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
