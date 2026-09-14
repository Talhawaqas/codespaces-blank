// app/api/ai/voice-session/end/route.js
// POST { orgId, sessionId, durationMs, requestCount, toolCallCount, errorCount, endReason }
// -> records the session's real end, releases its concurrency slot.
//
// Inaya AI Voice Assistant SOW. Called by the client on explicit stop(),
// onclose, or a client-detected error -- best-effort (if the browser tab
// closes without calling this, the session simply has no endedAt/duration
// recorded; it does NOT stay counted against the concurrency cap forever,
// since that cap lives in the in-memory Map keyed by session id and this
// route is the only place that clears it -- see the "known limitations"
// note in the final report about relying on a clean client-side close).

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { requireMembership } from "../../../../../lib/orgs.js";
import { logVoiceSessionEnd } from "../../../../../lib/ai-voice-session.js";
import { trackConcurrentSession } from "../../../../../lib/voice-rate-limit.js";

export async function POST(req) {
  try {
    const { orgId, sessionId, durationMs, requestCount, toolCallCount, errorCount, endReason } = await req.json();
    if (!orgId || !sessionId) return NextResponse.json({ error: "orgId and sessionId are required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let recordId;
    try {
      recordId = new ObjectId(sessionId);
    } catch {
      return NextResponse.json({ error: "Invalid sessionId." }, { status: 400 });
    }

    await logVoiceSessionEnd({
      recordId, orgId, email: auth.session.email,
      durationMs: Number(durationMs) || 0,
      requestCount: Number(requestCount) || 0,
      toolCallCount: Number(toolCallCount) || 0,
      errorCount: Number(errorCount) || 0,
      endReason: endReason || "user_stopped",
    });

    trackConcurrentSession(`${orgId}:${auth.session.email}`, sessionId, "close");

    return NextResponse.json({ ended: true });
  } catch (err) {
    console.error("voice-session/end POST failed:", err);
    return NextResponse.json({ error: "Could not record the session end." }, { status: 500 });
  }
}
