// app/api/ai/voice-session/route.js
// POST { orgId, currentView } -> mints a short-lived, single-use Gemini
// Live API ephemeral token locked to this org's business context/tools.
//
// Inaya AI Voice Assistant SOW. Thin route -- all real logic lives in
// src/lib/ai-voice-session.js (kept separate for unit-testability, since
// this repo has no route-level AI tests). Auth is the exact same
// requireMembership() every /api/orgs/* route uses; nothing AI-specific
// is invented for authorization.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { getOrgProfile } from "../../../../lib/industry-config.js";
import { isVoiceEnabledForOrg, mintVoiceToken, logVoiceSessionStart, logVoiceSessionEnd } from "../../../../lib/ai-voice-session.js";
import { checkRateLimit, trackConcurrentSession } from "../../../../lib/voice-rate-limit.js";

export async function POST(req) {
  try {
    const { orgId, currentView } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const profile = await getOrgProfile(orgId);
    if (!isVoiceEnabledForOrg(profile)) {
      return NextResponse.json({ error: "Voice AI is not enabled for this workspace." }, { status: 403 });
    }

    const rateLimitKey = `${orgId}:${auth.session.email}`;
    const rateLimit = checkRateLimit(rateLimitKey, "session_start");
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many voice sessions started recently -- please wait a moment and try again." }, { status: 429 });
    }

    const result = await mintVoiceToken({
      orgId, membership: auth.membership, email: auth.session.email, org, currentView,
      maxSessionSeconds: Number(process.env.GEMINI_VOICE_MAX_SESSION_SECONDS) || undefined,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 502 });

    const recordId = await logVoiceSessionStart({ orgId, email: auth.session.email, model: result.model });
    const sessionId = recordId.toString();

    const concurrency = trackConcurrentSession(rateLimitKey, sessionId, "open");
    if (!concurrency.allowed) {
      // A real token was minted and a session row started before we knew
      // the concurrency cap was already hit -- close it out immediately
      // rather than leaving an orphaned "open" row with no end. The
      // Gemini-side token itself is single-use and short-lived (60s open
      // window), so it simply expires unused; no separate revoke needed.
      await logVoiceSessionEnd({ recordId, orgId, email: auth.session.email, durationMs: 0, endReason: "concurrency_limit" });
      return NextResponse.json({ error: "You already have the maximum number of voice sessions open." }, { status: 429 });
    }

    return NextResponse.json({
      token: result.token,
      model: result.model,
      expiresAt: result.expiresAt,
      sessionId,
    });
  } catch (err) {
    console.error("voice-session POST failed:", err);
    return NextResponse.json({ error: "Could not start a voice session." }, { status: 500 });
  }
}
