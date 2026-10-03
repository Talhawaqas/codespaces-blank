// src/lib/voice-rate-limit.js
//
// Inaya AI Voice Assistant SOW (§16) -- rate limits for the voice routes, keyed by
// `${orgId}:${email}` (every voice caller is already authenticated via requireMembership).
//
// State lives in Mongo (the shared `rate_limit_hits` collection via slidingWindowCheck, plus
// `voice_open_sessions` for the concurrent-session cap), so the limits hold across serverless
// instances instead of multiplying by the instance count as the earlier in-memory version did.

import { connectToDatabase } from "./mongodb.js";
import { slidingWindowCheck } from "./rateLimit.js";

const WINDOWS = {
  session_start: { windowMs: 60_000, max: Number(process.env.GEMINI_VOICE_RATE_LIMIT) || 5 },
  tool_call: { windowMs: 60_000, max: 60 },
};

const MAX_CONCURRENT_SESSIONS_PER_KEY = 2;
// A voice session can't legitimately stay open this long; the TTL reclaims slots from sessions
// whose browser vanished without ever calling /end.
const OPEN_SESSION_TTL_SECONDS = 2 * 60 * 60;

let indexesEnsured = false;
async function openSessions() {
  const { db } = await connectToDatabase();
  const collection = db.collection("voice_open_sessions");
  if (!indexesEnsured) {
    await collection.createIndex({ key: 1, sessionId: 1 }, { unique: true });
    await collection.createIndex({ openedAt: 1 }, { expireAfterSeconds: OPEN_SESSION_TTL_SECONDS });
    indexesEnsured = true;
  }
  return collection;
}

/** Sliding-window check for `kind` ("session_start" | "tool_call"), keyed by an
 *  already-authenticated `key`. Resolves to {allowed:true} or {allowed:false, retryAfterMs}. */
export async function checkRateLimit(key, kind) {
  const config = WINDOWS[kind];
  if (!config) throw new Error(`Unknown rate-limit kind: ${kind}`);
  const result = await slidingWindowCheck({ action: `voice:${kind}`, key, max: config.max, windowMs: config.windowMs });
  return result.allowed ? { allowed: true } : { allowed: false, retryAfterMs: result.retryAfterMs };
}

/** Tracks concurrently-open voice sessions per key -- a sliding window can't express "at most N
 *  open at once". Call with action:"open" before minting a token and action:"close" once the
 *  session ends; an open() call itself enforces the cap. */
export async function trackConcurrentSession(key, sessionId, action) {
  if (action !== "open" && action !== "close") throw new Error(`Unknown concurrent-session action: ${action}`);
  const collection = await openSessions();

  if (action === "open") {
    const current = await collection.countDocuments({ key });
    if (current >= MAX_CONCURRENT_SESSIONS_PER_KEY) return { allowed: false, current };
    await collection.updateOne({ key, sessionId }, { $setOnInsert: { openedAt: new Date() } }, { upsert: true });
    return { allowed: true };
  }

  await collection.deleteOne({ key, sessionId });
  return { allowed: true };
}

/** Test helper -- removes every voice limiter record. Never called from request-handling code. */
export async function __resetForTests() {
  const { db } = await connectToDatabase();
  await db.collection("rate_limit_hits").deleteMany({ action: /^voice:/ });
  await (await openSessions()).deleteMany({});
}
