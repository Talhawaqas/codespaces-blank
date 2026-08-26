// src/app/api/ai/chat/route.js
//
// Docs chatbot endpoint (Gemini-backed). Combines:
//  - Rate limiting + wallet-context injection (from a parallel session)
//  - Streaming, per-request client creation, and correct model/token config
//    (fixes already established earlier in this project — see notes below)
//
// 1. RATE LIMITING — a simple in-memory sliding-window limiter per IP address,
//    now risk-aware (Fraud & Abuse Protection Layer, Phase 2): the per-IP limit
//    tightens for MEDIUM/HIGH-risk connections (VPN/proxy/Tor/datacenter alone
//    only ever tightens the limit, never blocks -- see lib/fraudRisk.js's
//    false-positive guarantee) and only a CONFIRMED reputation signal rejects
//    outright. CAVEAT: this resets on every cold start and is NOT shared across
//    serverless instances — on Vercel that means it's a soft speed bump, not a
//    hard guarantee. It's still worth having (stops a single runaway browser tab
//    or basic script), but if you need a real guarantee later, move this to
//    Vercel KV / Upstash Redis (same interface, persists across instances) —
//    flagged here so it's not mistaken for a hard limit.
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
import { assessRisk } from '@/lib/fraudRisk';
import { retrieveContext, formatAttribution } from '@/lib/rag/retrieve';
import { wrapContextBlock } from '@/lib/rag/sanitize';

// RAG grounding instructions — replaces the old static INAYA_KNOWLEDGE_BASE
// injection. The retrieved context block (wrapped/sanitized by
// wrapContextBlock) is appended per-request instead of one fixed string,
// so the assistant is grounded in whatever's actually indexed rather than
// whatever fit in a hand-maintained prompt constant. Per the SOW: if
// retrieval comes up empty, the assistant must say so plainly, never
// fall back to the model's own (unverifiable, possibly stale or wrong)
// pretrained knowledge about Inaya.
const DOCS_BASE_INSTRUCTION = `You are the official docs assistant for Inaya Network, embedded as a chat widget on the Inaya Network dApp. Answer user questions using ONLY the retrieved reference material provided below for this specific question — never invent contract addresses, prices, figures, or features that aren't in it. Keep answers short (2-5 sentences unless the user asks for detail), friendly, and technically precise. Do not give financial or investment advice — only factual product information.

If the retrieved material doesn't contain enough information to answer, say plainly that this isn't in Inaya's indexed documentation yet — do not guess, and do not fall back on general knowledge about blockchain/crypto projects to fill the gap. For a genuinely unanswerable question, route the person onward: general product questions → support@inayanetwork.com; bugs/technical issues → support@inayanetwork.com; partnerships → partners@inayanetwork.com; investor/fundraising questions → investors@inayanetwork.com. Live/real-time on-chain figures (exact current balance, today's live APY) should point the user to the relevant dApp tab rather than guessing a number, even if a nearby figure appears in the retrieved material.`;

// ============================================================
// Rate limiter — in-memory sliding window, per IP
// ============================================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 12;     // 12 messages / minute / IP, for a normal/unflagged IP
const requestLog = new Map(); // ip -> array of timestamps

// Fraud & Abuse Protection Layer, Phase 2 -- the "apply rate limits to
// high-risk traffic" integration point from the SOW. Risk is cached per IP
// (not assessed per message) so a busy legitimate chat session doesn't
// trigger a proxycheck.io lookup on every single message -- only once per
// RISK_CACHE_TTL_MS. Same "simple in-memory, not distributed across
// serverless instances" caveat as requestLog above; a soft speed bump, not
// a hard guarantee, consistent with this route's existing rate limiter.
const RISK_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const riskCache = new Map(); // ip -> { action, cachedAt }

async function getCachedRiskAction(req, ip) {
  const cached = riskCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < RISK_CACHE_TTL_MS) return cached.action;

  // assessRisk() never throws (fails open to ALLOW internally) -- worst
  // case this adds one lookup's worth of latency to the first message from
  // a given IP every 10 minutes, never a new failure mode.
  const assessment = await assessRisk({ req, identityId: ip, surface: "api" });
  riskCache.set(ip, { action: assessment.recommendedAction, cachedAt: Date.now() });
  if (riskCache.size > 5000) {
    for (const [key, entry] of riskCache.entries()) {
      if (Date.now() - entry.cachedAt > RISK_CACHE_TTL_MS) riskCache.delete(key);
    }
  }
  return assessment.recommendedAction;
}

// RESTRICT/TEMPORARILY_BLOCK require a CONFIRMED reputation signal (see
// lib/fraudRisk.js) -- connection type (VPN/proxy/Tor/datacenter) alone
// can only ever reach VERIFY, which tightens the limit rather than
// blocking, keeping this consistent with every other Phase 2 integration
// point's false-positive guarantee.
function rateLimitForAction(action) {
  if (action === "RESTRICT" || action === "TEMPORARILY_BLOCK") return 0;
  if (action === "VERIFY") return Math.ceil(RATE_LIMIT_MAX_REQUESTS / 4); // 3 / minute
  if (action === "MONITOR") return Math.ceil(RATE_LIMIT_MAX_REQUESTS / 2); // 6 / minute
  return RATE_LIMIT_MAX_REQUESTS; // ALLOW -- normal limit
}

function isRateLimited(ip, maxRequests) {
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

  return timestamps.length > maxRequests;
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
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// Unlike business-chat/security-chat/learn-chat, this route streams — so
// the usual "retry the whole call" pattern doesn't directly apply once
// bytes have started reaching the client. Observed in production: Gemini's
// generateContentStream() call itself succeeds (no synchronous throw), but
// the FIRST chunk pulled from the returned async iterator throws a 503
// ("currently experiencing high demand") — by then this route had already
// sent 200 headers and an empty stream, so the client got nothing and no
// real error. Fix: pull the first chunk here, inside the retry loop,
// BEFORE the Response (and its headers) is constructed at all — a failure
// here still has a clean path to a real JSON error.
const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [700, 1800];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startStreamWithRetry(ai, params) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const responseStream = await ai.models.generateContentStream(params);
      const iterator = responseStream[Symbol.asyncIterator]();
      const first = await iterator.next(); // forces Gemini's first real network response now, not later
      return { iterator, first };
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_STATUSES.has(err?.status) || attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`chat: Gemini stream got ${err.status} on first chunk, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

export async function POST(req) {
  try {
    const clientIp = getClientIp(req);
    const riskAction = await getCachedRiskAction(req, clientIp);
    const effectiveLimit = rateLimitForAction(riskAction);
    if (effectiveLimit === 0) {
      return Response.json(
        { error: "This request couldn't be completed from your current network. If you believe this is a mistake, please try again later or contact support." },
        { status: 403 }
      );
    }
    if (isRateLimited(clientIp, effectiveLimit)) {
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

    const latestUserMessage = [...messages].reverse().find((m) => m.role !== 'assistant')?.content || '';
    const { chunks: ragChunks, hasResults } = await retrieveContext({ query: latestUserMessage, domain: 'docs' });
    const systemInstruction = DOCS_BASE_INSTRUCTION + wrapContextBlock(ragChunks) + formatWalletContext(walletContext);

    // STREAMING: generateContentStream yields chunks as Gemini produces them,
    // instead of making the browser wait for the entire reply before showing
    // anything. We forward each chunk's text straight through as plain text,
    // so the widget can render the reply progressively.
    //
    // The first chunk is pulled (with retry) BEFORE headers are sent — see
    // startStreamWithRetry's comment. Only once that succeeds do we commit
    // to a 200 streaming response.
    let iterator, first;
    try {
      ({ iterator, first } = await startStreamWithRetry(ai, {
        model: 'gemini-flash-latest', // auto-updating alias — avoids breaking again on the next model deprecation/shutdown
        contents: trimmedMessages,
        config: {
          systemInstruction,
          maxOutputTokens: 800, // headroom above thinking-token usage so real answers don't get cut off mid-sentence
          thinkingConfig: {
            thinkingLevel: 'low' // this is a simple FAQ/docs bot — it doesn't need deep multi-step reasoning, and keeping this low leaves more of the token budget for the visible reply
          }
        }
      }));
    } catch (err) {
      // Failed before any streaming started, or every retry on the first
      // chunk was exhausted — safe to return a normal JSON error here since
      // no response body has gone to the client yet.
      console.error('Chat route error (before streaming started, after retries):', err);
      return Response.json({ error: "The AI is taking longer than usual to respond right now — please try again in a moment." }, { status: 502 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          if (!first.done && first.value?.text) controller.enqueue(encoder.encode(first.value.text));
          while (true) {
            const { done, value } = await iterator.next();
            if (done) break;
            if (value.text) controller.enqueue(encoder.encode(value.text));
          }
          // Attribution appended after the streamed reply, only for
          // sources actually retrieved and used — never fabricated.
          if (hasResults) controller.enqueue(encoder.encode(formatAttribution(ragChunks)));
        } catch (err) {
          // Once streaming has begun we can no longer switch to a JSON error
          // body — the browser already received a 200 with a text/plain
          // stream. Log server-side and just end the stream cleanly; the
          // widget will show whatever text made it through, or its own
          // "couldn't generate a response" fallback if nothing did.
          console.error('Chat route error (mid-stream, after first chunk):', err);
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