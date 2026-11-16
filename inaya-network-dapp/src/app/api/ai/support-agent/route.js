// src/app/api/ai/support-agent/route.js
//
// POST /api/ai/support-agent   Body: { orgId, messages: [{ role: 'user'|'assistant', content }] }
// The Inaya Support Agent (src/lib/supportAgent.js): diagnoses a signed-in customer's problem with
// read-only tools and fixes what it safely can (company name, industry edition, re-sending an
// invitation) after the customer confirms; everything else is escalated to the team by email.
// Same model, retry, Groq fallback and AI security gateway pattern as /api/ai/business-chat.

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ensureOrgIndexes, requireMembership, canManageOrg, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { SUPPORT_TOOL_DECLARATIONS, supportSystemInstruction, buildSupportContext, runSupportTool } from "../../../../lib/supportAgent.js";
import { runGroqToolLoop, isGroqConfigured } from "../../../../lib/groqFallback.js";
import { checkInputSecurity, validateOutput } from "../../../../lib/aiSecurity/gateway.js";

export const maxDuration = 90;
const MAX_TOOL_ROUNDS = 6;
const CALL_TIMEOUT_MS = 15_000;
const SAFETY_BUDGET_MS = 50_000;
const BUSY = "The support assistant is busy right now. Please try again in a moment, or email contact@inayanetwork.com.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("support-agent: Gemini call timed out"), { status: 503 })), CALL_TIMEOUT_MS))]);
}
async function generate(ai, params) {
  try {
    return await withTimeout(ai.models.generateContent(params));
  } catch (err) {
    if (![429, 503].includes(err?.status)) throw err;
    await sleep(1000);
    return withTimeout(ai.models.generateContent(params));
  }
}

async function runGeminiLoop(ai, contents, systemInstruction, ctx) {
  const started = Date.now();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (Date.now() - started > SAFETY_BUDGET_MS) throw Object.assign(new Error("support-agent: safety budget exceeded"), { status: 503 });
    const response = await generate(ai, {
      model: "gemini-3.5-flash-lite",
      contents,
      config: { systemInstruction, tools: [{ functionDeclarations: SUPPORT_TOOL_DECLARATIONS }], maxOutputTokens: 900, thinkingConfig: { thinkingLevel: "low" } },
    });
    const calls = response.functionCalls;
    if (!calls || calls.length === 0) return response.text || "";
    contents.push(response.candidates?.[0]?.content || { role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    const parts = [];
    for (const call of calls) {
      let result;
      try { result = await runSupportTool(call.name, call.args, ctx); } catch (err) { console.error(`support-agent: tool ${call.name} failed:`, err); result = { error: "That check failed unexpectedly; escalate to the team if it matters." }; }
      parts.push({ functionResponse: { name: call.name, response: result } });
    }
    contents.push({ role: "user", parts });
  }
  return "";
}

export async function POST(req) {
  try {
    const { orgId, messages } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!Array.isArray(messages) || messages.length === 0) return NextResponse.json({ error: "messages array is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const latest = [...messages].reverse().find((m) => m.role !== "assistant")?.content || "";
    const security = await checkInputSecurity({ orgId, actorEmail: auth.session.email, surface: "support-agent", userInput: String(latest).slice(0, 4000) });
    if (!security.allowed) return NextResponse.json({ error: security.reason }, { status: 403 });

    const apiKey = process.env.GEMINI_API_KEY;
    const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
    if (!ai && !isGroqConfigured()) return NextResponse.json({ error: BUSY }, { status: 503 });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } });
    const ctx = await buildSupportContext({ orgId, membership: auth.membership, email: auth.session.email });
    const systemInstruction = supportSystemInstruction({ orgName: org?.name, email: auth.session.email, role: auth.membership.role, isManager: canManageOrg(auth.membership) });
    const contents = messages.slice(-12).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content || "").slice(0, 2000) }] }));

    let text = "";
    try {
      if (!ai) throw Object.assign(new Error("no Gemini key"), { status: 500 });
      text = await runGeminiLoop(ai, contents, systemInstruction, ctx);
    } catch (err) {
      console.error("support-agent: Gemini path failed:", err.message);
      if (!isGroqConfigured()) return NextResponse.json({ error: BUSY }, { status: 503 });
      try {
        text = await runGroqToolLoop({ systemInstruction, geminiToolDeclarations: SUPPORT_TOOL_DECLARATIONS, initialContents: contents, runTool: runSupportTool, ctx, maxRounds: MAX_TOOL_ROUNDS });
      } catch (groqErr) {
        console.error("support-agent: Groq fallback failed:", groqErr.message);
        return NextResponse.json({ error: BUSY }, { status: 503 });
      }
    }
    if (!text) text = "Sorry, I couldn't work that out. Could you describe the problem in a bit more detail? I can also pass it to the Inaya team.";
    const validated = await validateOutput({ orgId, actorEmail: auth.session.email, requestId: security.requestId, surface: "support-agent", outputText: text });
    return NextResponse.json({ reply: validated.text });
  } catch (err) {
    console.error("support-agent failed:", err);
    return NextResponse.json({ error: BUSY }, { status: 502 });
  }
}
