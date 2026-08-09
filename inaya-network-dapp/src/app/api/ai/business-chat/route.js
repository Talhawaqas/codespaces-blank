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

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
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

    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let response;
      try {
        response = await ai.models.generateContent({
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
