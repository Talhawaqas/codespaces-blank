// app/api/ai/security-chat/route.js
//
// POST /api/ai/security-chat
// Body: { identityId, messages: [{ role: 'user'|'assistant', content }] }
//
// The AI Security Assistant — same Gemini model + tool-calling loop shape
// as /api/ai/business-chat, but scoped to the Security Layer's own tools
// (src/lib/ai-security-tools.js). identityId is the caller's own wallet
// address or device id (client-provided, same trust model as every other
// anonymous-identity route in this codebase — activity.js, watcherPioneer.js)
// — the model can only ever see that identity's own event history, plus
// public threat-feed lookups, never anyone else's.
//
// Not streaming, same reasoning as business-chat: an unpredictable number
// of tool-calling round trips before there's a final answer to show.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { buildSecurityContext, runSecurityTool, SECURITY_TOOL_DECLARATIONS, securitySystemInstruction } from "../../../../lib/ai-security-tools.js";
import { ensureSecurityIndexes } from "../../../../lib/security.js";

const MAX_TOOL_ROUNDS = 5;
// See business-chat/route.js's identical constant for why: leaves a buffer
// under maxDuration=90 to return a clean error instead of a silent hard
// timeout when Gemini is under sustained load.
const SAFETY_BUDGET_MS = 75_000;

export const maxDuration = 90;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [700, 1800];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateContentWithRetry(ai, params) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`security-chat: Gemini call got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

export async function POST(req) {
  try {
    const { identityId, messages } = await req.json();
    if (!identityId) return NextResponse.json({ error: "identityId is required." }, { status: 400 });
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array is required." }, { status: 400 });
    }

    await ensureSecurityIndexes();

    const ai = getGeminiClient();
    if (!ai) {
      console.error("security-chat: GEMINI_API_KEY is missing.");
      return NextResponse.json({ error: "AI service is not configured." }, { status: 500 });
    }

    const ctx = await buildSecurityContext({ identityId });
    const systemInstruction = securitySystemInstruction();

    let contents = messages.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 2000) }],
    }));

    const requestStartedAt = Date.now();
    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (Date.now() - requestStartedAt > SAFETY_BUDGET_MS) {
        console.warn("security-chat: aborting before the safety budget to avoid a silent hard timeout");
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
      let response;
      try {
        response = await generateContentWithRetry(ai, {
          model: "gemini-flash-latest",
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: SECURITY_TOOL_DECLARATIONS }],
            maxOutputTokens: 800,
            thinkingConfig: { thinkingLevel: "low" },
          },
        });
      } catch (err) {
        console.error("security-chat: Gemini call failed:", err);
        return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
      }

      const calls = response.functionCalls;
      if (!calls || calls.length === 0) {
        finalText = response.text || "";
        break;
      }

      const modelContent = response.candidates?.[0]?.content;
      contents.push(modelContent || { role: "model", parts: calls.map((c) => ({ functionCall: c })) });

      const responseParts = [];
      for (const call of calls) {
        let result;
        try {
          result = await runSecurityTool(call.name, call.args, ctx);
        } catch (err) {
          console.error(`security-chat: tool ${call.name} failed:`, err);
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
    console.error("security-chat failed:", err);
    return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
  }
}
