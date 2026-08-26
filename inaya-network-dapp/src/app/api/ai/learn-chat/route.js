// app/api/ai/learn-chat/route.js
//
// POST /api/ai/learn-chat
// Body: { walletAddress, videoContext, messages: [{ role: 'user'|'assistant', content }] }
//
// The Inaya Learn AI Tutor — same Gemini tool-calling loop shape as
// /api/ai/business-chat and /api/ai/security-chat, but a teaching
// assistant rather than a data-lookup one: it answers using its own
// general knowledge, and only calls tools (src/lib/ai-learn-tools.js) to
// ground answers about the user's own saved videos/progress. walletAddress
// is optional — an anonymous user (no wallet connected yet) can still ask
// the tutor to explain the video they're watching, they just won't get
// personalized saved/progress answers.
//
// Not streaming, same reasoning as the other two AI routes: an
// unpredictable number of tool-calling round trips before a final answer.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { buildLearnContext, runLearnTool, LEARN_TOOL_DECLARATIONS, learnSystemInstruction } from "../../../../lib/ai-learn-tools.js";
import { ensureLearnIndexes } from "../../../../lib/learn.js";

const MAX_TOOL_ROUNDS = 5;
// See business-chat/route.js's identical constants for the full story: a
// between-round budget check alone wasn't enough because a single Gemini
// call can hang far longer than expected before returning a 503, so
// CALL_TIMEOUT_MS bounds each individual attempt too.
const CALL_TIMEOUT_MS = 15_000;
const SAFETY_BUDGET_MS = 45_000;

export const maxDuration = 90;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [1000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCallTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`), { status: 503 })), CALL_TIMEOUT_MS)),
  ]);
}

async function generateContentWithRetry(ai, params) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await withCallTimeout(ai.models.generateContent(params), "learn-chat: Gemini call");
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`learn-chat: Gemini call got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

export async function POST(req) {
  try {
    const { walletAddress, videoContext, messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array is required." }, { status: 400 });
    }

    await ensureLearnIndexes();

    const ai = getGeminiClient();
    if (!ai) {
      console.error("learn-chat: GEMINI_API_KEY is missing.");
      return NextResponse.json({ error: "AI service is not configured." }, { status: 500 });
    }

    const ctx = await buildLearnContext({ walletAddress, videoContext });
    const systemInstruction = learnSystemInstruction({ videoContext: ctx.videoContext, transcriptAvailable: ctx.transcriptAvailable });

    let contents = messages.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 2000) }],
    }));

    const requestStartedAt = Date.now();
    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (Date.now() - requestStartedAt > SAFETY_BUDGET_MS) {
        console.warn("learn-chat: aborting before the safety budget to avoid a silent hard timeout");
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
      let response;
      try {
        response = await generateContentWithRetry(ai, {
          model: "gemini-3.5-flash-lite",
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: LEARN_TOOL_DECLARATIONS }],
            maxOutputTokens: 800,
            thinkingConfig: { thinkingLevel: "low" },
          },
        });
      } catch (err) {
        console.error("learn-chat: Gemini call failed:", err);
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
          result = await runLearnTool(call.name, call.args, ctx);
        } catch (err) {
          console.error(`learn-chat: tool ${call.name} failed:`, err);
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
    console.error("learn-chat failed:", err);
    return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
  }
}
