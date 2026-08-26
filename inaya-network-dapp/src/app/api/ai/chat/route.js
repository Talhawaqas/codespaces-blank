// src/app/api/ai/chat/route.js
//
// Docs chatbot endpoint.
// PRIMARY: Gemini
// FALLBACK: Groq
//
// Combines:
//  - Rate limiting + wallet-context injection
//  - Fraud & Abuse Protection Layer
//  - RAG retrieval from MongoDB Atlas
//  - Gemini streaming with retry
//  - Groq streaming fallback when Gemini is unavailable
//  - Source attribution
//
// IMPORTANT:
// - Gemini remains the PRIMARY provider.
// - Groq is only used when Gemini fails BEFORE streaming begins.
// - Existing RAG infrastructure is unchanged.
// - Existing retrieved context is passed to Groq exactly as it is passed to Gemini.
// - Private/user-specific data is not added to the shared RAG store.
// - Once Gemini has successfully started streaming, we cannot safely switch
//   providers mid-stream.

import { GoogleGenAI } from '@google/genai';
import { assessRisk } from '@/lib/fraudRisk';
import { retrieveContext, formatAttribution } from '@/lib/rag/retrieve';
import { wrapContextBlock } from '@/lib/rag/sanitize';
import {
  convertGeminiContentsToGroqMessages,
  groqCompleteStream,
  isGroqConfigured,
} from '@/lib/groqFallback';

// ============================================================
// RAG grounding instructions
// ============================================================

const DOCS_BASE_INSTRUCTION = `You are the official docs assistant for Inaya Network, embedded as a chat widget on the Inaya Network dApp. Answer user questions using ONLY the retrieved reference material provided below for this specific question — never invent contract addresses, prices, figures, or features that aren't in it. Keep answers short (2-5 sentences unless the user asks for detail), friendly, and technically precise. Do not give financial or investment advice — only factual product information.

If the retrieved material doesn't contain enough information to answer, say plainly that this isn't in Inaya's indexed documentation yet — do not guess, and do not fall back on general knowledge about blockchain/crypto projects to fill the gap. For a genuinely unanswerable question, route the person onward: general product questions → support@inayanetwork.com; bugs/technical issues → support@inayanetwork.com; partnerships → partners@inayanetwork.com; investor/fundraising questions → investors@inayanetwork.com. Live/real-time on-chain figures (exact current balance, today's live APY) should point the user to the relevant dApp tab rather than guessing a number, even if a nearby figure appears in the retrieved material.`;

// ============================================================
// Rate limiter — in-memory sliding window, per IP
// ============================================================

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const requestLog = new Map();

// ============================================================
// Fraud & Abuse Protection Layer
// ============================================================

const RISK_CACHE_TTL_MS = 10 * 60 * 1000;
const riskCache = new Map();

async function getCachedRiskAction(req, ip) {
  const cached = riskCache.get(ip);

  if (cached && Date.now() - cached.cachedAt < RISK_CACHE_TTL_MS) {
    return cached.action;
  }

  const assessment = await assessRisk({
    req,
    identityId: ip,
    surface: "api",
  });

  riskCache.set(ip, {
    action: assessment.recommendedAction,
    cachedAt: Date.now(),
  });

  if (riskCache.size > 5000) {
    for (const [key, entry] of riskCache.entries()) {
      if (Date.now() - entry.cachedAt > RISK_CACHE_TTL_MS) {
        riskCache.delete(key);
      }
    }
  }

  return assessment.recommendedAction;
}

function rateLimitForAction(action) {
  if (action === "RESTRICT" || action === "TEMPORARILY_BLOCK") return 0;
  if (action === "VERIFY") return Math.ceil(RATE_LIMIT_MAX_REQUESTS / 4);
  if (action === "MONITOR") return Math.ceil(RATE_LIMIT_MAX_REQUESTS / 2);
  return RATE_LIMIT_MAX_REQUESTS;
}

function isRateLimited(ip, maxRequests) {
  const now = Date.now();

  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  timestamps.push(now);
  requestLog.set(ip, timestamps);

  if (requestLog.size > 5000) {
    for (const [key, times] of requestLog.entries()) {
      if (times.every((t) => now - t > RATE_LIMIT_WINDOW_MS)) {
        requestLog.delete(key);
      }
    }
  }

  return timestamps.length > maxRequests;
}

function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for");

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return req.headers.get("x-real-ip") || "unknown";
}

// ============================================================
// Wallet context
// ============================================================

function formatWalletContext(walletContext) {
  if (!walletContext || !walletContext.walletAddress) {
    return "";
  }

  const {
    walletAddress,
    staking,
    payg,
    corporatePlan,
  } = walletContext;

  const lines = [
    `\n\n## LIVE WALLET DATA (real-time, for THIS connected user only — not from the knowledge base above)`,
    `Connected wallet: ${walletAddress}`,
  ];

  if (staking) {
    lines.push(
      `Staking: ${staking.myStakedBalance} INAYA staked, ${staking.claimableRewards} INAYA claimable, tier: ${staking.userTier}` +
        (
          staking.lockExpiryTimestamp > Date.now()
            ? `, locked until ${new Date(staking.lockExpiryTimestamp).toLocaleDateString()}`
            : ", no active lock"
        )
    );
  }

  if (payg) {
    lines.push(
      `Pay-As-You-Go: ${payg.tbCommitted} TB committed, storage ${payg.storageActive ? "ACTIVE" : "LAPSED"}, maintenance ${payg.maintenanceCurrent ? "current" : "not current"}` +
        (
          payg.storagePaidThrough
            ? `, paid through ${new Date(payg.storagePaidThrough).toLocaleDateString()}`
            : ""
        )
    );
  }

  lines.push(
    corporatePlan
      ? `Corporate Reserve: active ${corporatePlan.tier} plan, valid until ${new Date(corporatePlan.expiresAt).toLocaleDateString()}`
      : `Corporate Reserve: no active plan`
  );

  lines.push(
    `When the user asks about their own balance, stake, subscription, or plan status, answer using ONLY these live figures — never invent numbers, and never apply this data to any wallet other than the one listed above.`
  );

  return lines.join("\n");
}

// ============================================================
// Gemini client
// ============================================================

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new GoogleGenAI({ apiKey });
}

// ============================================================
// Route duration
// ============================================================

export const maxDuration = 60;

// ============================================================
// Gemini retry configuration
// ============================================================

const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [1000];
const CALL_TIMEOUT_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCallTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`),
              { status: 503 }
            )
          ),
        CALL_TIMEOUT_MS
      )
    ),
  ]);
}

async function startStreamWithRetry(ai, params) {
  let lastErr;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await withCallTimeout(
        (async () => {
          const responseStream = await ai.models.generateContentStream(params);

          const iterator = responseStream[Symbol.asyncIterator]();

          // Force Gemini's first actual network response before
          // committing HTTP 200 headers to the browser.
          const first = await iterator.next();

          return {
            iterator,
            first,
          };
        })(),
        "chat: Gemini stream"
      );
    } catch (err) {
      lastErr = err;

      if (
        !RETRYABLE_STATUSES.has(err?.status) ||
        attempt === RETRY_DELAYS_MS.length
      ) {
        throw err;
      }

      console.warn(
        `chat: Gemini stream got ${err.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`
      );

      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastErr;
}

// ============================================================
// Groq fallback stream
// ============================================================
//
// This converts the SAME Gemini-style contents and the SAME RAG-derived
// system instruction into Groq/OpenAI-compatible messages.
//
// No RAG retrieval happens again.
// No new database lookup happens.
// No private data is added anywhere.
//

async function startGroqFallbackStream(systemInstruction, trimmedMessages) {
  if (!isGroqConfigured()) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const messages = convertGeminiContentsToGroqMessages(
    systemInstruction,
    trimmedMessages
  );

  const responseStream = groqCompleteStream({
    messages,
  });

  const iterator = responseStream[Symbol.asyncIterator]();

  // Force the first Groq response before returning HTTP 200.
  const first = await iterator.next();

  return {
    iterator,
    first,
  };
}

// ============================================================
// POST
// ============================================================

export async function POST(req) {
  try {
    // ----------------------------------------------------------
    // Fraud / rate limiting
    // ----------------------------------------------------------

    const clientIp = getClientIp(req);

    const riskAction = await getCachedRiskAction(
      req,
      clientIp
    );

    const effectiveLimit = rateLimitForAction(riskAction);

    if (effectiveLimit === 0) {
      return Response.json(
        {
          error:
            "This request couldn't be completed from your current network. If you believe this is a mistake, please try again later or contact support.",
        },
        { status: 403 }
      );
    }

    if (isRateLimited(clientIp, effectiveLimit)) {
      return Response.json(
        {
          error:
            "You're sending messages a bit fast — please wait a moment and try again.",
        },
        { status: 429 }
      );
    }

    // ----------------------------------------------------------
    // Request body
    // ----------------------------------------------------------

    const { messages, walletContext } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: "messages array is required" },
        { status: 400 }
      );
    }

    // ----------------------------------------------------------
    // Provider availability
    // ----------------------------------------------------------

    const ai = getGeminiClient();

    const groqAvailable = isGroqConfigured();

    if (!ai && !groqAvailable) {
      console.error(
        "Chat route error: neither GEMINI_API_KEY nor GROQ_API_KEY is configured."
      );

      return Response.json(
        {
          error:
            "AI service is not configured. Please check the server AI provider configuration.",
        },
        { status: 500 }
      );
    }

    if (!ai && groqAvailable) {
      console.warn(
        "chat: GEMINI_API_KEY is unavailable. Using Groq as primary fallback provider."
      );
    }

    // ----------------------------------------------------------
    // Message protection
    // ----------------------------------------------------------

    const trimmedMessages = messages.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: String(m.content || "").slice(0, 2000),
        },
      ],
    }));

    // ----------------------------------------------------------
    // RAG RETRIEVAL
    // ----------------------------------------------------------
    //
    // IMPORTANT:
    // This is unchanged.
    //
    // The same retrieved documentation is supplied to Gemini
    // or Groq. The fallback does NOT bypass RAG.
    //

    const latestUserMessage =
      [...messages]
        .reverse()
        .find((m) => m.role !== "assistant")
        ?.content || "";

    const {
      chunks: ragChunks,
      hasResults,
    } = await retrieveContext({
      query: latestUserMessage,
      domain: "docs",
    });

    const systemInstruction =
      DOCS_BASE_INSTRUCTION +
      wrapContextBlock(ragChunks) +
      formatWalletContext(walletContext);

    // ----------------------------------------------------------
    // PRIMARY: Gemini
    // ----------------------------------------------------------

    let iterator;
    let first;
    let provider = "gemini";

    if (ai) {
      try {
        ({ iterator, first } = await startStreamWithRetry(ai, {
          model: "gemini-3.5-flash-lite",
          contents: trimmedMessages,
          config: {
            systemInstruction,
            maxOutputTokens: 800,
            thinkingConfig: {
              thinkingLevel: "low",
            },
          },
        }));

        console.log("chat: Gemini response started successfully.");
      } catch (geminiError) {
        // ------------------------------------------------------
        // FALLBACK: Groq
        // ------------------------------------------------------

        console.error(
          "chat: Gemini failed before streaming started. Attempting Groq fallback.",
          geminiError
        );

        if (!groqAvailable) {
          return Response.json(
            {
              error:
                "The AI is taking longer than usual to respond right now — please try again in a moment.",
            },
            { status: 502 }
          );
        }

        try {
          ({ iterator, first } =
            await startGroqFallbackStream(
              systemInstruction,
              trimmedMessages
            ));

          provider = "groq";

          console.log(
            "chat: Groq fallback response started successfully."
          );
        } catch (groqError) {
          console.error(
            "chat: Groq fallback also failed.",
            groqError
          );

          return Response.json(
            {
              error:
                "The AI is taking longer than usual to respond right now — please try again in a moment.",
            },
            { status: 502 }
          );
        }
      }
    } else {
      // --------------------------------------------------------
      // Gemini unavailable entirely → Groq
      // --------------------------------------------------------

      try {
        ({ iterator, first } =
          await startGroqFallbackStream(
            systemInstruction,
            trimmedMessages
          ));

        provider = "groq";

        console.log(
          "chat: Gemini unavailable. Groq fallback started successfully."
        );
      } catch (groqError) {
        console.error(
          "chat: Gemini unavailable and Groq fallback failed.",
          groqError
        );

        return Response.json(
          {
            error:
              "The AI is taking longer than usual to respond right now — please try again in a moment.",
          },
          { status: 502 }
        );
      }
    }

    // ----------------------------------------------------------
    // STREAM RESPONSE
    // ----------------------------------------------------------

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // First chunk was deliberately pulled before HTTP headers
          // were committed.
          if (!first.done) {
            if (provider === "gemini") {
              if (first.value?.text) {
                controller.enqueue(
                  encoder.encode(first.value.text)
                );
              }
            } else {
              if (first.value) {
                controller.enqueue(
                  encoder.encode(first.value)
                );
              }
            }
          }

          // ----------------------------------------------------
          // Continue streaming
          // ----------------------------------------------------

          while (true) {
            const { done, value } = await iterator.next();

            if (done) {
              break;
            }

            if (provider === "gemini") {
              if (value?.text) {
                controller.enqueue(
                  encoder.encode(value.text)
                );
              }
            } else {
              // Groq generator yields plain text chunks.
              if (value) {
                controller.enqueue(
                  encoder.encode(value)
                );
              }
            }
          }

          // ----------------------------------------------------
          // Attribution
          // ----------------------------------------------------

          if (hasResults) {
            controller.enqueue(
              encoder.encode(
                formatAttribution(ragChunks)
              )
            );
          }
        } catch (err) {
          // Once streaming has begun, we cannot safely switch
          // from Gemini to Groq because the browser already has
          // an HTTP 200 response.
          //
          // End the stream cleanly and log the actual failure.
          console.error(
            `Chat route error during ${provider} streaming:`,
            err
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Inaya-AI-Provider": provider,
      },
    });
  } catch (err) {
    console.error("Chat route error:", err);

    return Response.json(
      {
        error: "AI service temporarily unavailable.",
      },
      { status: 502 }
    );
  }
}