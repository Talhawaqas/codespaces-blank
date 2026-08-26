// src/app/api/ai/business-chat/route.js
//
// POST /api/ai/business-chat
// Body: { orgId, messages: [{ role: 'user'|'assistant', content }] }
//
// The AI Business Assistant — the same Gemini model the docs FAQ bot
// (/api/ai/chat) uses, but authenticated (requireMembership, same as
// every other /api/orgs/* route) and given function-calling tools over
// this org's departments/projects/documents/activity instead of a static
// knowledge base.
//
// PERMISSIONS: this route never queries org data directly. Every tool
// call goes through runBusinessTool() (lib/ai-business-tools.js), which
// operates over a context built from getAccessibleScope() — the caller's
// real, permission-resolved view of the org, the same one every other
// route uses. The model can only ask questions; it cannot expand its own
// visibility. See ai-business-tools.js's header comment for the full
// argument.
//
// Not streaming (unlike /api/ai/chat) — this can take several tool-calling
// round trips before there's a final answer to show, so a single JSON
// response once the loop settles is simpler and more honest than trying
// to stream through an unpredictable number of intermediate tool turns.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ensureOrgIndexes, requireMembership, canManageOrg, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { buildBusinessContext, runBusinessTool, BUSINESS_TOOL_DECLARATIONS, businessSystemInstruction } from "../../../../lib/ai-business-tools.js";

const MAX_TOOL_ROUNDS = 5;
// Leaves a buffer under maxDuration=90 to actually return a clean error —
// observed in production: a round hitting a 503 retry mid-loop can run the
// whole request past 90s, and Vercel then hard-kills the function with NO
// response ever reaching the client (the chat just hangs on "Thinking…"
// forever, worse than a real error). This budget makes that fail fast and
// visibly instead.
const SAFETY_BUDGET_MS = 75_000;

// Unlike /api/ai/chat (a single streamed call), this route can make up to
// MAX_TOOL_ROUNDS sequential Gemini calls plus MongoDB queries before it
// has a final answer, each with its own retry-on-503 backoff below —
// observed taking ~55s end-to-end during a period of real Gemini API
// congestion. Comfortably past Vercel's default function duration if left
// unset, with headroom above that observed worst case.
export const maxDuration = 90;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE_STATUSES = new Set([429, 503]); // rate-limited / model overloaded — both transient
const RETRY_DELAYS_MS = [700, 1800]; // two retries: short backoff, then a longer one

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gemini's flash models intermittently return a 503 "currently experiencing
 *  high demand" under load — seen in production for this exact route. A
 *  short retry-with-backoff turns that into a slightly slower reply instead
 *  of a hard failure, without masking a genuinely broken key/config (those
 *  fail with a different status and aren't retried). */
async function generateContentWithRetry(ai, params) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`business-chat: Gemini call got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

export async function POST(req) {
  try {
    const { orgId, messages } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array is required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const ai = getGeminiClient();
    if (!ai) {
      console.error("business-chat: GEMINI_API_KEY is missing.");
      return NextResponse.json({ error: "AI service is not configured." }, { status: 500 });
    }

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const ctx = await buildBusinessContext({ orgId, membership: auth.membership, email: auth.session.email });
    const systemInstruction = businessSystemInstruction({
      orgName: org.name,
      role: auth.membership.role,
      isManager: canManageOrg(auth.membership),
    });

    // Same trimming discipline as /api/ai/chat — cap history length and
    // message size so a runaway client can't blow up API costs.
    let contents = messages.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 2000) }],
    }));

    const requestStartedAt = Date.now();
    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (Date.now() - requestStartedAt > SAFETY_BUDGET_MS) {
        console.warn("business-chat: aborting before the safety budget to avoid a silent hard timeout (Gemini likely under sustained load)");
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
      let response;
      try {
        response = await generateContentWithRetry(ai, {
          model: "gemini-flash-latest",
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: BUSINESS_TOOL_DECLARATIONS }],
            maxOutputTokens: 800,
            thinkingConfig: { thinkingLevel: "low" },
          },
        });
      } catch (err) {
        console.error("business-chat: Gemini call failed:", err);
        return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
      }

      const calls = response.functionCalls;
      if (!calls || calls.length === 0) {
        finalText = response.text || "";
        break;
      }

      // Push the model's own turn (the function call request) verbatim,
      // then run each tool through the SAME permission-scoped context and
      // push the results back as the next turn, per Gemini's function-
      // calling protocol.
      const modelContent = response.candidates?.[0]?.content;
      contents.push(modelContent || { role: "model", parts: calls.map((c) => ({ functionCall: c })) });

      const responseParts = [];
      for (const call of calls) {
        let result;
        try {
          result = await runBusinessTool(call.name, call.args, ctx);
        } catch (err) {
          console.error(`business-chat: tool ${call.name} failed:`, err);
          result = { error: "This lookup failed unexpectedly." };
        }
        responseParts.push({ functionResponse: { name: call.name, response: result } });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    if (!finalText) {
      finalText = "I wasn't able to put together an answer for that — could you try rephrasing?";
    }

    return NextResponse.json({ reply: finalText });
  } catch (err) {
    console.error("business-chat failed:", err);
    return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
  }
}
