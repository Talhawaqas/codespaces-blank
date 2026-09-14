// src/lib/voice-rate-limit.js
//
// Inaya AI Voice Assistant SOW (§16) — /api/ai/business-chat has NO rate
// limiter at all today (confirmed: only the public docs bot at
// /api/ai/chat has one). This generalizes that existing limiter's exact
// shape -- in-memory sliding-window Map, opportunistic eviction past 5000
// keys (see src/app/api/ai/chat/route.js's requestLog/isRateLimited) --
// keyed by `${orgId}:${email}` instead of IP, since every voice caller is
// already authenticated (requireMembership), unlike the public docs bot.
//
// Known limitation, stated plainly rather than hidden: this state is
// per-server-instance, in-memory, not shared (no Redis/similar exists
// anywhere in this codebase). On a multi-instance deployment the real
// effective limit is max * instance_count, not a hard global cap -- the
// exact same accepted trade-off the existing docs-bot limiter already
// carries. Worth revisiting with a shared store if voice usage grows
// enough for that gap to matter in practice.

const WINDOWS = {
  session_start: { windowMs: 60_000, max: Number(process.env.GEMINI_VOICE_RATE_LIMIT) || 5 },
  tool_call: { windowMs: 60_000, max: 60 },
};

const MAX_CONCURRENT_SESSIONS_PER_KEY = 2;
const MAP_EVICTION_THRESHOLD = 5000;

const slidingWindows = new Map(); // `${kind}:${key}` -> timestamps[]
const concurrentSessions = new Map(); // key -> Set<sessionId>

function evictStale(map, windowMs) {
  if (map.size <= MAP_EVICTION_THRESHOLD) return;
  const now = Date.now();
  for (const [mapKey, timestamps] of map.entries()) {
    if (timestamps.every((t) => now - t > windowMs)) map.delete(mapKey);
  }
}

/** Sliding-window check for `kind` ("session_start" | "tool_call"), keyed
 *  by an already-authenticated `key` (e.g. `${orgId}:${email}`). Returns
 *  {allowed:true} or {allowed:false, retryAfterMs}. */
export function checkRateLimit(key, kind) {
  const config = WINDOWS[kind];
  if (!config) throw new Error(`Unknown rate-limit kind: ${kind}`);

  const mapKey = `${kind}:${key}`;
  const now = Date.now();
  const timestamps = (slidingWindows.get(mapKey) || []).filter((t) => now - t < config.windowMs);

  if (timestamps.length >= config.max) {
    const retryAfterMs = config.windowMs - (now - timestamps[0]);
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  slidingWindows.set(mapKey, timestamps);
  evictStale(slidingWindows, config.windowMs);
  return { allowed: true };
}

/** Tracks concurrently-open voice sessions per key -- a sliding window
 *  can't express "at most N open at once" (a session may stay open far
 *  longer than any reasonable window), so this is a separate Set-based
 *  cap instead. Call with action:"open" before minting a token and
 *  action:"close" once the session ends (explicit stop, onclose, or a
 *  server-side timeout sweep) -- an open() call itself enforces the cap. */
export function trackConcurrentSession(key, sessionId, action) {
  if (action === "open") {
    const current = concurrentSessions.get(key) || new Set();
    if (current.size >= MAX_CONCURRENT_SESSIONS_PER_KEY) {
      return { allowed: false, current: current.size };
    }
    current.add(sessionId);
    concurrentSessions.set(key, current);
    return { allowed: true };
  }
  if (action === "close") {
    const current = concurrentSessions.get(key);
    if (!current) return { allowed: true };
    current.delete(sessionId);
    if (current.size === 0) concurrentSessions.delete(key);
    return { allowed: true };
  }
  throw new Error(`Unknown concurrent-session action: ${action}`);
}

/** Test/ops helper -- clears all in-memory state. Never called from
 *  request-handling code. */
export function __resetForTests() {
  slidingWindows.clear();
  concurrentSessions.clear();
}
