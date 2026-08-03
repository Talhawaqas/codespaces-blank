// src/lib/admin-auth.js
//
// Phase 3 Tier 2 — auth for the internal Enterprise Dashboard. There was
// no "admin" concept anywhere in this codebase before this — every
// existing pattern (wallet signature, Stripe cookie session) is designed
// for a customer accessing their OWN data, not an operator aggregating
// everyone's. Deliberately the simplest viable option per the SOW: a
// single shared admin passphrase, stored as an env var
// (ADMIN_DASHBOARD_PASSPHRASE — set your own value in .env.local /
// Vercel, never commit or paste the actual value anywhere), checked
// server-side before any dashboard route returns data.
//
// Session model: on successful login, the client gets an HttpOnly cookie
// containing sha256(passphrase) — not the raw passphrase — so it's never
// sitting in a browser-inspectable cookie value in plaintext. Every
// dashboard API route re-derives the same hash from the env var and
// compares with a timing-safe check before returning anything.

import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "inaya_admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Compares a submitted passphrase against ADMIN_DASHBOARD_PASSPHRASE. Throws if the env var
 *  isn't configured at all, rather than silently treating "unset" as "any passphrase works." */
export function verifyAdminPassphrase(submittedPassphrase) {
  const expected = process.env.ADMIN_DASHBOARD_PASSPHRASE;
  if (!expected) {
    throw new Error("ADMIN_DASHBOARD_PASSPHRASE is not configured on the server — the dashboard cannot be enabled until it's set.");
  }
  if (!submittedPassphrase) return false;
  return timingSafeStringEqual(submittedPassphrase, expected);
}

/** The exact cookie value a successful login should set. */
export function computeAdminSessionCookieValue() {
  return sha256Hex(process.env.ADMIN_DASHBOARD_PASSPHRASE);
}

/** Every dashboard API route calls this first. Returns true only if the request carries a
 *  cookie matching sha256(ADMIN_DASHBOARD_PASSPHRASE) — never trusts a bare "logged in" flag. */
export function isAdminAuthenticated(req) {
  const expected = process.env.ADMIN_DASHBOARD_PASSPHRASE;
  if (!expected) return false;
  const cookieValue = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!cookieValue) return false;
  return timingSafeStringEqual(cookieValue, computeAdminSessionCookieValue());
}

export const ADMIN_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
};
