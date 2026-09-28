// src/lib/moderator-auth.js
//
// Auth for the Moderator Dashboard — a deliberately LIMITED surface (only
// Watcher Pioneer Program wallets + KYC'd individuals), separate from the
// full Enterprise Admin Dashboard (admin-auth.js, which sees revenue,
// customers, business orgs, fraud internals, node operators — everything).
// A moderator credential must never be able to reach admin-only data, so
// this is its own passphrase (MODERATOR_DASHBOARD_PASSPHRASE), its own
// cookie, and its own routes — not a lower "role" bolted onto the admin
// session, which would risk a future admin route forgetting to check scope
// and exposing itself to moderators. Same proven mechanism as admin-auth.js
// otherwise: sha256(passphrase) in an HttpOnly cookie, timing-safe compare,
// re-checked server-side on every request.

import { createHash, timingSafeEqual } from "node:crypto";

export const MODERATOR_SESSION_COOKIE = "inaya_moderator_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours, matches admin session length

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyModeratorPassphrase(submittedPassphrase) {
  const expected = process.env.MODERATOR_DASHBOARD_PASSPHRASE;
  if (!expected) {
    throw new Error("MODERATOR_DASHBOARD_PASSPHRASE is not configured on the server — the moderator dashboard cannot be enabled until it's set.");
  }
  if (!submittedPassphrase) return false;
  return timingSafeStringEqual(submittedPassphrase, expected);
}

export function computeModeratorSessionCookieValue() {
  return sha256Hex(process.env.MODERATOR_DASHBOARD_PASSPHRASE);
}

/** Every moderator dashboard API route calls this first. */
export function isModeratorAuthenticated(req) {
  const expected = process.env.MODERATOR_DASHBOARD_PASSPHRASE;
  if (!expected) return false;
  const cookieValue = req.cookies.get(MODERATOR_SESSION_COOKIE)?.value;
  if (!cookieValue) return false;
  return timingSafeStringEqual(cookieValue, computeModeratorSessionCookieValue());
}

export const MODERATOR_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
};
