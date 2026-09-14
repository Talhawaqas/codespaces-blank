// app/api/ai/voice-tool-relay/route.js
// POST { orgId, toolName, args } -> executes one tool call on behalf of an
// active voice session and returns its result.
//
// Inaya AI Voice Assistant SOW. This is the ONLY place any business-tool
// logic ever executes for voice -- the ephemeral Gemini Live token proves
// nothing about ongoing authorization (it's just a live-API connection
// credential), so every single tool call is re-authorized here via the
// exact same requireMembership() + buildBusinessContext() the text
// assistant uses per request, then dispatched through the SAME
// runBusinessTool() business-chat/route.js calls -- zero duplicated
// business logic (SOW §11), and cross-workspace isolation is identical to
// the text path by construction, not by separate discipline.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { buildBusinessContext, runBusinessTool } from "../../../../lib/ai-business-tools.js";
import { checkRateLimit } from "../../../../lib/voice-rate-limit.js";

export async function POST(req) {
  try {
    const { orgId, toolName, args, currentView } = await req.json();
    if (!orgId || !toolName) return NextResponse.json({ error: "orgId and toolName are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const rateLimit = checkRateLimit(`${orgId}:${auth.session.email}`, "tool_call");
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many voice requests right now -- please slow down." }, { status: 429 });
    }

    // Rebuilt fresh, never reused from token-mint time -- guarantees the
    // CURRENT scope (a permission change mid-session takes effect
    // immediately), matching the text assistant's own per-request rebuild.
    const ctx = { ...(await buildBusinessContext({ orgId, membership: auth.membership, email: auth.session.email })), currentView: currentView || null };

    let result;
    try {
      result = await runBusinessTool(toolName, args || {}, ctx);
    } catch (err) {
      console.error(`voice-tool-relay: tool ${toolName} failed:`, err);
      result = { error: "This lookup failed unexpectedly." };
    }

    return NextResponse.json({ result });
  } catch (err) {
    console.error("voice-tool-relay POST failed:", err);
    return NextResponse.json({ error: "Could not run that request." }, { status: 500 });
  }
}
