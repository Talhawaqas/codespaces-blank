// src/app/api/ai/chat/route.js
//
// Docs chatbot endpoint (Gemini-backed). Combines:
//  - Rate limiting + wallet-context injection (from a parallel session)
//  - Streaming, per-request client creation, and correct model/token config
//    (fixes already established earlier in this project — see notes below)
//
// 1. RATE LIMITING — a simple in-memory sliding-window limiter per IP address.
//    CAVEAT: this resets on every cold start and is NOT shared across serverless
//    instances — on Vercel that means it's a soft speed bump, not a hard guarantee.
//    It's still worth having (stops a single runaway browser tab or basic script),
//    but if you need a real guarantee later, move this to Vercel KV / Upstash Redis
//    (same interface, persists across instances) — flagged here so it's not mistaken
//    for a hard limit.
//
// 2. WALLET CONTEXT — accepts an optional `walletContext` object (built client-side
//    from state the frontend already fetched — no extra RPC calls here) and folds it
//    into the system instruction as clearly-labeled LIVE DATA, separate from the
//    static knowledge base, so the assistant can answer "what's my staked balance"
//    style questions accurately instead of guessing or deflecting.
//
// 3. IMPORTANT — the Gemini client is created FRESH per request inside the handler,
//    not once at module load time. If GEMINI_API_KEY isn't loaded yet at the exact
//    moment this module first compiles, a module-scope client would cache that
//    broken state for the life of the dev server / serverless instance.
//
// 4. Uses `generateContentStream` + a ReadableStream response so replies render
//    progressively in the widget instead of popping in all at once, and the
//    `gemini-flash-latest` alias (auto-tracks Google's current fast/cheap Flash
//    model) instead of a hardcoded version string — Google has deprecated/shut
//    down two hardcoded Flash versions already this year (2.0 in June, 2.5 for
//    new keys this month), so pinning a specific version number is a recurring
//    outage risk for this project specifically.

import { GoogleGenAI } from '@google/genai';
import { INAYA_KNOWLEDGE_BASE } from '@/lib/inaya-knowledge';

// ============================================================
// Rate limiter — in-memory sliding window, per IP
// ============================================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 12;     // 12 messages / minute / IP
const requestLog = new Map(); // ip -> array of timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);

  // Periodic cleanup so this Map doesn't grow forever across a long-lived instance
  if (requestLog.size > 5000) {
    for (const [key, times] of requestLog.entries()) {
      if (times.every((t) => now - t > RATE_LIMIT_WINDOW_MS)) requestLog.delete(key);
    }
  }

  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

// ============================================================
// Wallet context formatting — turns the frontend's state snapshot into a
// short, clearly-labeled block appended to the system instruction for THIS
// request only. Never persisted, never mixed into the static knowledge base.
// ============================================================
function formatWalletContext(walletContext) {
  if (!walletContext || !walletContext.walletAddress) return '';

  const { walletAddress, staking, payg, corporatePlan } = walletContext;

  const lines = [
    `\n\n## LIVE WALLET DATA (real-time, for THIS connected user only — not from the knowledge base above)`,
    `Connected wallet: ${walletAddress}`,
  ];

  if (staking) {
    lines.push(
      `Staking: ${staking.myStakedBalance} INAYA staked, ${staking.claimableRewards} INAYA claimable, tier: ${staking.userTier}` +
      (staking.lockExpiryTimestamp > Date.now() ? `, locked until ${new Date(staking.lockExpiryTimestamp).toLocaleDateString()}` : ', no active lock')
    );
  }

  if (payg) {
    lines.push(
      `Pay-As-You-Go: ${payg.tbCommitted} TB committed, storage ${payg.storageActive ? 'ACTIVE' : 'LAPSED'}, maintenance ${payg.maintenanceCurrent ? 'current' : 'not current'}` +
      (payg.storagePaidThrough ? `, paid through ${new Date(payg.storagePaidThrough).toLocaleDateString()}` : '')
    );
  }

  lines.push(
    corporatePlan
      ? `Corporate Reserve: active ${corporatePlan.tier} plan, valid until ${new Date(corporatePlan.expiresAt).toLocaleDateString()}`
      : `Corporate Reserve: no active plan`
  );

  lines.push(`When the user asks about their own balance, stake, subscription, or plan status, answer using ONLY these live figures — never invent numbers, and never apply this data to any wallet other than the one listed above.`);

  return lines.join('\n');
}

// Created fresh per request — see note #3 above.
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('DEBUG GEMINI_API_KEY present:', !!apiKey, '| length:', (apiKey || '').length);
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

export async function POST(req) {
  try {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
      return Response.json(
        { error: "You're sending messages a bit fast — please wait a moment and try again." },
        { status: 429 }
      );
    }

    const { messages, walletContext } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: 'messages array is required' }, { status: 400 });
    }

    const ai = getGeminiClient();
    if (!ai) {
      console.error('Chat route error: GEMINI_API_KEY is missing or empty in process.env.');
      return Response.json(
        { error: 'Server misconfiguration: GEMINI_API_KEY is not set. Check .env / .env.local in the inaya-network-dapp folder and restart the dev server.' },
        { status: 500 }
      );
    }

    // Same guardrails as before: cap history length and message size so a
    // runaway/malicious client can't blow up your API costs in one request.
    const trimmedMessages = messages.slice(-12).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user', // Gemini calls the assistant role "model"
      parts: [{ text: String(m.content || '').slice(0, 2000) }]
    }));

    const systemInstruction = INAYA_KNOWLEDGE_BASE + formatWalletContext(walletContext);

    // STREAMING: generateContentStream yields chunks as Gemini produces them,
    // instead of making the browser wait for the entire reply before showing
    // anything. We forward each chunk's text straight through as plain text,
    // so the widget can render the reply progressively.
    let responseStream;
    try {
      responseStream = await ai.models.generateContentStream({
        model: 'gemini-flash-latest', // auto-updating alias — avoids breaking again on the next model deprecation/shutdown
        contents: trimmedMessages,
        config: {
          systemInstruction,
          maxOutputTokens: 800, // headroom above thinking-token usage so real answers don't get cut off mid-sentence
          thinkingConfig: {
            thinkingLevel: 'low' // this is a simple FAQ/docs bot — it doesn't need deep multi-step reasoning, and keeping this low leaves more of the token budget for the visible reply
          }
        }
      });
    } catch (err) {
      // Failed before any streaming started (bad key, model not found, network
      // issue reaching Google) — safe to return a normal JSON error here since
      // no response body has gone to the client yet.
      console.error('Chat route error (before streaming started):', err);
      return Response.json({ error: 'AI service temporarily unavailable.' }, { status: 502 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of responseStream) {
            if (chunk.text) {
              controller.enqueue(encoder.encode(chunk.text));
            }
          }
        } catch (err) {
          // Once streaming has begun we can no longer switch to a JSON error
          // body — the browser already received a 200 with a text/plain
          // stream. Log server-side and just end the stream cleanly; the
          // widget will show whatever text made it through, or its own
          // "couldn't generate a response" fallback if nothing did.
          console.error('Chat route error (mid-stream):', err);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (err) {
    console.error('Chat route error:', err);
    return Response.json({ error: 'AI service temporarily unavailable.' }, { status: 502 });
  }
}