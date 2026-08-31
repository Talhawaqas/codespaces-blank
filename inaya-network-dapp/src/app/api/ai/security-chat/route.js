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
import { runGroqToolLoop, isGroqConfigured } from "../../../../lib/groqFallback.js";

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
      return await withCallTimeout(ai.models.generateContent(params), "security-chat: Gemini call");
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`security-chat: Gemini call got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

async function runGeminiLoop(ai, contents, systemInstruction, ctx) {
  const requestStartedAt = Date.now();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() - requestStartedAt > SAFETY_BUDGET_MS) {
      throw Object.assign(new Error("security-chat: aborting before the safety budget to avoid a silent hard timeout"), { status: 503 });
    }
    const response = await generateContentWithRetry(ai, {
      model: "gemini-3.5-flash-lite",
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: SECURITY_TOOL_DECLARATIONS }],
        maxOutputTokens: 800,
        thinkingConfig: { thinkingLevel: "low" },
      },
    });

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) return response.text || "";

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
  return "";
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
    if (!ai && !isGroqConfigured()) {
      console.error("security-chat: neither GEMINI_API_KEY nor GROQ_API_KEY is configured.");
      return NextResponse.json({ error: "AI service is not configured." }, { status: 500 });
    }

    const ctx = await buildSecurityContext({ identityId });
    const systemInstruction = securitySystemInstruction();

    const contents = messages.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 2000) }],
    }));

    let finalText = "";
    try {
      if (!ai) throw Object.assign(new Error("security-chat: GEMINI_API_KEY is missing."), { status: 500 });
      finalText = await runGeminiLoop(ai, contents, systemInstruction, ctx);
    } catch (err) {
      console.error("security-chat: Gemini path failed:", err.message);
      if (!isGroqConfigured()) {
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
      console.warn("security-chat: falling back to Groq...");
      try {
        finalText = await runGroqToolLoop({
          systemInstruction,
          geminiToolDeclarations: SECURITY_TOOL_DECLARATIONS,
          initialContents: contents,
          runTool: runSecurityTool,
          ctx,
          maxRounds: MAX_TOOL_ROUNDS,
        });
      } catch (groqErr) {
        console.error("security-chat: Groq fallback also failed:", groqErr.message);
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
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
