// src/app/api/ai/os-chat/route.js
//
// POST /api/ai/os-chat
// Body: { orgId, messages: [{ role: 'user'|'assistant', content }] }
//
// Enterprise OS SOW, Phase 6 — the OS-Level AI Assistant, org scope.
// Structurally mirrors /api/ai/business-chat's route (same
// requireMembership gate, same Gemini retry/timeout budget, same Groq
// fallback via runGroqToolLoop) deliberately, matching this codebase's
// existing convention of each chat route independently owning its own
// copy of that scaffold rather than a shared wrapper (confirmed: business/
// security/learn-chat already each do this) — business-chat/route.js
// itself is untouched by this file's existence.
//
// The one real difference: tools/context/system-instruction come from
// ai-os-router.js instead of ai-business-tools.js directly, so this
// conversation can call BOTH business and security tools in one turn.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ensureOrgIndexes, requireMembership, canManageOrg, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
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
      return await withCallTimeout(ai.models.generateContent(params), "os-chat: Gemini call");
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`os-chat: Gemini call got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

async function runGeminiLoop(ai, contents, systemInstruction, toolDeclarations, ctx) {
  const requestStartedAt = Date.now();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() - requestStartedAt > SAFETY_BUDGET_MS) {
      throw Object.assign(new Error("os-chat: aborting before the safety budget to avoid a silent hard timeout (Gemini likely under sustained load)"), { status: 503 });
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
        console.error(`os-chat: tool ${call.name} failed:`, err);
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
    const { orgId, messages } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array is required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const ai = getGeminiClient();
    if (!ai && !isGroqConfigured()) {
      console.error("os-chat: neither GEMINI_API_KEY nor GROQ_API_KEY is configured.");
      return NextResponse.json({ error: "AI service is not configured." }, { status: 500 });
    }

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const ctx = await buildOsContext({ scope: "org", orgId, membership: auth.membership, email: auth.session.email });
    const toolDeclarations = getOsToolDeclarations("org");
    const systemInstruction = osSystemInstruction({
      scope: "org",
      orgName: org.name,
      role: auth.membership.role,
      isManager: canManageOrg(auth.membership),
    });

    const contents = messages.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 2000) }],
    }));

    let finalText = "";
    try {
      if (!ai) throw Object.assign(new Error("os-chat: GEMINI_API_KEY is missing."), { status: 500 });
      finalText = await runGeminiLoop(ai, contents, systemInstruction, toolDeclarations, ctx);
    } catch (err) {
      console.error("os-chat: Gemini path failed:", err.message);
      if (!isGroqConfigured()) {
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
      console.warn("os-chat: falling back to Groq...");
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
        console.error("os-chat: Groq fallback also failed:", groqErr.message);
        return NextResponse.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 503 });
      }
    }

    if (!finalText) {
      finalText = "I wasn't able to put together an answer for that — could you try rephrasing?";
    }

    return NextResponse.json({ reply: finalText });
  } catch (err) {
    console.error("os-chat failed:", err);
    return NextResponse.json({ error: "AI service temporarily unavailable." }, { status: 502 });
  }
}
