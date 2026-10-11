// Node-facing (not org-session, not API-key): a node proves it holds a
// valid one-time enrollment token minted by an org admin via
// POST /api/orgs/infrastructure/clusters/[clusterId]/enrollment-tokens.
// SOW §42 — the node never asserts its own orgId; it's derived entirely
// from the token record, same "credential alone establishes identity"
// discipline as requireApiKey().
import { NextResponse } from "next/server";
import { enrollNode, InfrastructureError } from "../../../../../lib/infrastructure/nodes.js";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await enrollNode({
      enrollmentToken: body.enrollmentToken,
      hostname: body.hostname,
      csrPem: body.csrPem,
    });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof InfrastructureError) {
      return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
    }
    console.error("node enrollment failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
