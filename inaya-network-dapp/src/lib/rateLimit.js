// src/lib/rateLimit.js
//
// Small, generic sliding-window rate limiter backed by Mongo -- same
// countDocuments-over-a-time-window idiom security.js's recordSecurityReport()
// already uses for per-node report throttling, generalized so unauthenticated
// endpoints (login-link requests, org creation, admin login) can each get a
// cheap abuse guard without a new dependency (Redis/Upstash) or any
// deployment-specific infra. Not a distributed rate limiter in the
// strict sense -- it's a shared Mongo collection every serverless instance
// reads/writes, which is exactly what's needed here (no in-memory state
// that would reset per cold start or diverge per instance).

import { connectToDatabase } from "./mongodb.js";

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const TTL_SECONDS = 24 * 60 * 60; // garbage-collect hit records after 24h regardless of window used

export async function ensureRateLimitIndexes() {
  const { db } = await connectToDatabase();
  const collection = db.collection("rate_limit_hits");
  await collection.createIndex({ action: 1, key: 1, createdAt: 1 });
  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
}

/** Throws "Too many attempts..." once `key` (an IP, email, etc.) has made `max` calls tagged
 *  `action` within the last `windowMs`. Records this call regardless of outcome -- a rejected
 *  attempt still counts, which is what makes this an actual limiter and not just a counter. */
export async function checkRateLimit({ action, key, max, windowMs = DEFAULT_WINDOW_MS }) {
  const { db } = await connectToDatabase();
  const collection = db.collection("rate_limit_hits");
  const since = new Date(Date.now() - windowMs);

  const recentCount = await collection.countDocuments({ action, key, createdAt: { $gte: since } });
  await collection.insertOne({ action, key, createdAt: new Date() });

  if (recentCount >= max) {
    throw new Error("Too many attempts — please wait a while and try again.");
  }
}

/** Best-effort caller IP from standard proxy headers. On a normal Vercel deployment,
 *  x-forwarded-for is set by Vercel itself and client-supplied values are explicitly rejected
 *  (per Vercel's own docs: "we ... overwrite the X-Forwarded-For header and do not forward
 *  external IPs ... to prevent IP spoofing") -- confirmed, not assumed, before relying on it for
 *  every rate limit in this codebase. x-vercel-forwarded-for is checked first anyway (security
 *  hardening pass, September 2026): Vercel's docs describe it as "identical to x-forwarded-for
 *  [unless] you're using a proxy on top of Vercel" -- i.e. it stays authoritative even if this
 *  project ever enables the paid "Trusted Proxy" feature (which relaxes x-forwarded-for itself),
 *  so preferring it costs nothing today and removes a footgun for that future config change. */
export function getClientIp(req) {
  const vercelForwarded = req.headers.get("x-vercel-forwarded-for");
  if (vercelForwarded) return vercelForwarded.split(",")[0].trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
