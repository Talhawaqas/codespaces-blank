// Node-facing: authenticated by the node's own certificate-signed token
// (see the architecture note in src/lib/infrastructure/nodes.js), not an
// org session or API key.
import { NextResponse } from "next/server";
import { recordHeartbeat, InfrastructureError } from "../../../../../lib/infrastructure/nodes.js";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await recordHeartbeat({
      signedToken: body.signedToken,
      capacity: body.capacity,
      runtimeVersion: body.runtimeVersion,
      kernelVersion: body.kernelVersion,
      qemuVersion: body.qemuVersion,
      clockOffsetMs: body.clockOffsetMs,
    });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof InfrastructureError) {
      return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
    }
    console.error("node heartbeat failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
