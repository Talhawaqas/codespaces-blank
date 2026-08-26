// src/lib/groqFallback.js
//
// Free fallback AI provider for when Gemini is failing/overloaded — Groq's
// Chat Completions API, which is OpenAI-compatible, so this is plain
// fetch against https://api.groq.com/openai/v1/chat/completions. No new
// SDK dependency, matching this codebase's hand-roll-small-utilities
// convention.
//
// Deliberately best-effort and fails open: isGroqConfigured() lets every
// call site skip straight to the existing "AI is taking longer than usual"
// error when GROQ_API_KEY isn't set, and every function here throws a
// plain Error on failure — the caller already knows how to turn that into
// the same clean user-facing error the Gemini path uses. This is a
// fallback for when the PRIMARY provider is down; it must never become a
// new way for a request to hang or fail worse than Gemini alone would.
//
// Model: llama-3.3-70b-versatile — Groq's free-tier flagship, fast, and
// supports function/tool calling, which the Business/Security/Learn
// assistants all need for their permission-scoped tool loops.

const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_TIMEOUT_MS = 20_000;
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export function isGroqConfigured() {
  return !!process.env.GROQ_API_KEY;
}

/** Gemini's function-declaration parameters are already JSON-Schema-shaped
 *  (properties/items/enum/required/description) — the ONE real difference
 *  is Gemini's Type enum uses uppercase string values ("STRING","OBJECT",
 *  "ARRAY","INTEGER","BOOLEAN") where JSON Schema (which OpenAI/Groq's
 *  tool format expects) uses lowercase. This is a recursive case-fix pass,
 *  not a real schema translation. */
function convertSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = { ...schema };
  if (typeof out.type === "string") out.type = out.type.toLowerCase();
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, convertSchema(v)]));
  }
  if (out.items) out.items = convertSchema(out.items);
  return out;
}

export function convertGeminiToolsToGroq(geminiDeclarations) {
  return geminiDeclarations.map((decl) => ({
    type: "function",
    function: {
      name: decl.name,
      description: decl.description,
      parameters: convertSchema(decl.parameters) || { type: "object", properties: {} },
    },
  }));
}

/** Gemini contents (role: user|model, parts:[{text}]) -> OpenAI/Groq
 *  messages (role: user|assistant, content: string), with the system
 *  instruction prepended as its own message (Gemini keeps that separate;
 *  OpenAI-shaped APIs fold it into the message list). Only plain text
 *  turns are converted here — tool-call/tool-response turns have
 *  different enough shapes between the two protocols that
 *  runGroqToolLoop() below reconstructs its own from scratch each call
 *  rather than trying to losslessly convert Gemini's version. */
export function convertGeminiContentsToGroqMessages(systemInstruction, contents) {
  const messages = [{ role: "system", content: systemInstruction }];
  for (const c of contents) {
    const text = (c.parts || []).map((p) => p.text || "").join("");
    if (!text) continue;
    messages.push({ role: c.role === "model" ? "assistant" : "user", content: text });
  }
  return messages;
}

async function groqFetch(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq API returned ${res.status}: ${errText.slice(0, 300)}`);
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

/** One non-streaming completion, optionally with tools. Returns a
 *  normalized { text, toolCalls } shape — toolCalls is
 *  [{ id, name, args }] (args already JSON.parsed) or []. */
export async function groqComplete({ messages, tools }) {
  const res = await groqFetch({
    model: GROQ_MODEL,
    messages,
    ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    max_tokens: 800,
  });
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const toolCalls = (message.tool_calls || []).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* malformed args from the model — leave {} rather than crash the loop */ }
    return { id: tc.id, name: tc.function.name, args };
  });
  return { text: message.content || "", toolCalls };
}

/** A full Groq-side tool-calling loop, mirroring the shape of each route's
 *  own Gemini loop: up to maxRounds, running each requested tool through
 *  the SAME permission-scoped dispatcher (runTool) and ctx the Gemini path
 *  uses, feeding results back as the next turn. Returns the final text, or
 *  "" if it never resolves to a plain-text answer within maxRounds — same
 *  "couldn't put together an answer" convention the Gemini loops use. */
export async function runGroqToolLoop({ systemInstruction, geminiToolDeclarations, initialContents, runTool, ctx, maxRounds = 5 }) {
  const tools = convertGeminiToolsToGroq(geminiToolDeclarations);
  const messages = convertGeminiContentsToGroqMessages(systemInstruction, initialContents);

  for (let round = 0; round < maxRounds; round++) {
    const { text, toolCalls } = await groqComplete({ messages, tools });
    if (!toolCalls.length) return text;

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
    });
    for (const call of toolCalls) {
      let result;
      try {
        result = await runTool(call.name, call.args, ctx);
      } catch (err) {
        result = { error: "This lookup failed unexpectedly." };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "";
}

/** Streaming variant for the Docs Assistant — yields text chunks as they
 *  arrive over Groq's OpenAI-compatible SSE format. */
export async function* groqCompleteStream({ messages }) {
  const res = await groqFetch({ model: GROQ_MODEL, messages, max_tokens: 800, stream: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the last (possibly incomplete) line for the next read
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // malformed SSE chunk — skip rather than crash the stream over one bad line
      }
    }
  }
}