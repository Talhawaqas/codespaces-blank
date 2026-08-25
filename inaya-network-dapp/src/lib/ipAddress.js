// src/lib/ipAddress.js
//
// Shared client-IP extraction for anything that needs it server-side.
// Mirrors the local getClientIp() already duplicated inside
// api/ai/chat/route.js's rate limiter -- that route is left untouched
// (out of scope for this pass), but every new fraud-layer call site uses
// this single implementation instead of re-deriving its own.
//
// x-forwarded-for can carry a comma-separated chain (client, proxy1,
// proxy2, ...) when multiple hops are involved -- the first entry is the
// original client. Vercel/most reverse proxies set this; x-real-ip is a
// fallback some setups use instead.

export function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
