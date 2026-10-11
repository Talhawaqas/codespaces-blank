import { NextResponse } from "next/server";
import { completeOperation, InfrastructureError } from "../../../../../../../lib/infrastructure/operations.js";

export async function POST(req, ctx) {
  try {
    const { operationId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const result = await completeOperation({ signedToken: body.signedToken, operationId, status: body.status, result: body.result, error: body.error });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof InfrastructureError) {
      return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
    }
    console.error("operation complete failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
