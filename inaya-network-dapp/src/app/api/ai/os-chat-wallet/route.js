// src/app/api/ai/os-chat-wallet/route.js
//
// POST /api/ai/os-chat-wallet
// Body: { walletAddress, messages: [{ role: 'user'|'assistant', content }] }
//
// Enterprise OS SOW, Phase 6 — the OS-Level AI Assistant, wallet scope.
// No signature required, matching /api/ai/security-chat's own existing
// precedent exactly (identityId passed directly in the body — the tools
// behind it only ever return the caller's own aggregate data, the same
// low-sensitivity trust tier as every other wallet-scoped GET route in
// this SOW). Otherwise structurally identical to os-chat/route.js's
// retry/timeout/Groq-fallback scaffold.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { buildOsContext, runOsTool, getOsToolDeclarations, osSystemInstruction } from "../../../../lib/ai-os-router.js";
import { runGroqToolLoop, isGroqConfigured } from "../../../../lib/groqFallback.js";

const MAX_TOOL_ROUNDS = 5;
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
      return await withCallTimeout(ai.models.generateContent(params), "os-chat-wallet: Gemini call");
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`os-chat-wallet: Gemini call got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

async function runGeminiLoop(ai, contents, systemInstruction, toolDeclarations, ctx) {
  const requestStartedAt = Date.now();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() - requestStartedAt > SAFETY_BUDGET_MS) {
      throw Object.assign(new Error("os-chat-wallet: aborting before the safety budget to avoid a silent hard timeout (Gemini likely under sustained load)"), { status: 503 });
    }
    const response = await generateContentWithRetry(ai, {
      model: "gemini-3.5-flash-lite",
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
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
        result = await runOsTool(call.name, call.args, ctx);
      } catch (err) {
        console.error(`os-chat-wallet: tool ${call.name} failed:`, err);
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
    const { walletAddress, messages } = await req.json();
    if (!walletAddress) return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array is required." }, { status: 400 });
    }

    const ai = getGeminiClient();
    if (!ai && !isGroqConfigured()) {
      console.error("os-chat-wallet: neither GEMINI_API_KEY nor GROQ_API_KEY is configured.");
      return NextResponse.json({ error: "AI service is not configured." }, { status: 500 });
    }

    const ctx = await buildOsContext({ scope: "wallet", walletAddress });
    const toolDeclarations = getOsToolDeclarations("wallet");
    const systemInstruction = osSystemInstruction({ scope: "wallet" });

    const contents = messages.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 2000) }],
    }));

    let finalText = "";
    try {
      if (!ai) throw Object.assign(new Error("os-chat-wallet: GEMINI_API_KEY is missing."), { status: 500 });
      finalText = await runGeminiLoop(ai, contents, systemInstruction, toolDeclarations, ctx);
    } catch (err) {
      console.error("os-chat-wallet: Gemini path failed:", err.message);
      if (!isGroqConfigured()) {
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
      console.warn("os-chat-wallet: falling back to Groq...");
      try {
        finalText = await runGroqToolLoop({
          systemInstruction,
          geminiToolDeclarations: toolDeclarations,
          initialContents: contents,
          runTool: runOsTool,
          ctx,
          maxRounds: MAX_TOOL_ROUNDS,
        });
      } catch (groqErr) {
        console.error("os-chat-wallet: Groq fallback also failed:", groqErr.message);
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
    }

    if (!finalText) {
      finalText = "I wasn't able to put together an answer for that — could you try rephrasing?";
    }

    return NextResponse.json({ reply: finalText });
  } catch (err) {
    console.error("os-chat-wallet failed:", err);
    return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
  }
}
