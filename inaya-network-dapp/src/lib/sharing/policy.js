// src/lib/sharing/policy.js
//
// Secure Sharing 2.0 (Competitive Expansion SOW workstream B): the pure rules. No database, no clock of its own, no network, so every
// rule is unit-testable. shares.js applies these rules against MongoDB; the routes only translate HTTP.
//
// Important honest boundary (documented in docs/architecture/secure-sharing-model.md): documents are encrypted on the owner's device
// with a passkey Inaya never sees. A Sharing 2.0 link therefore never hands out storage pointers; the recipient fetches CIPHERTEXT
// through Inaya, which is what lets expiry, revocation, counts, IP limits and passwords be enforced for every byte served.
// "View only" is a best-effort viewer mode, not a guarantee: a recipient who holds the passkey can decrypt what they were allowed
// to fetch (see the secure viewer notes). Revocation stops all further fetches; it cannot recall what was already downloaded.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { isValidCidr, ipMatchesAny } from "../net/cidr.js";

const scrypt = promisify(scryptCb);

export const LINK_PERMISSIONS = ["view", "download"];
export const MEMBER_PERMISSIONS = { view: "VIEW", edit: "EDIT", manage: "MANAGE" };
export const SHARE_KINDS = ["link", "member", "group"];
export const LIMITS = {
  passwordMin: 8, passwordMax: 128, ipEntries: 20, domainEntries: 10, labelMax: 80, noteMax: 500, managers: 10,
  maxExpiryDays: 365, maxMaxUses: 100000, sessionMinutes: 15, passwordAttempts: 8, lockMinutes: 15,
};

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const text = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

/**
 * Validates and normalizes the options of a new LINK share. Returns { value } or { errors: [..] }. `now` is injectable.
 * Expiry is resolved by the caller (document-permissions.resolveExpiresAt keeps the existing presets and one-year cap).
 */
export function validateLinkOptions(input = {}) {
  const errors = []; const v = {};
  v.permission = input.permission ?? "download";
  if (!LINK_PERMISSIONS.includes(v.permission)) errors.push(`permission must be one of ${LINK_PERMISSIONS.join(", ")}.`);
  v.oneTime = input.oneTime === true;
  const intOpt = (k, max) => {
    if (input[k] === undefined || input[k] === null || input[k] === "") return null;
    if (!Number.isInteger(input[k]) || input[k] < 1 || input[k] > max) { errors.push(`${k} must be a whole number between 1 and ${max}.`); return null; }
    return input[k];
  };
  v.maxUses = intOpt("maxUses", LIMITS.maxMaxUses);
  v.maxDownloads = intOpt("maxDownloads", LIMITS.maxMaxUses);
  if (v.oneTime) { v.maxUses = 1; if (v.permission === "download") v.maxDownloads = 1; }
  if (v.permission === "view" && v.maxDownloads !== null) errors.push("A view-only link has no downloads to limit.");
  if (input.password !== undefined && input.password !== null && input.password !== "") {
    const p = String(input.password);
    if (p.length < LIMITS.passwordMin || p.length > LIMITS.passwordMax) errors.push(`password must be ${LIMITS.passwordMin}-${LIMITS.passwordMax} characters.`);
    else v.password = p;
  }
  const ips = Array.isArray(input.ipAllow) ? input.ipAllow.map((x) => String(x).trim()).filter(Boolean) : [];
  if (ips.length > LIMITS.ipEntries) errors.push(`At most ${LIMITS.ipEntries} IP ranges.`);
  for (const c of ips) if (!isValidCidr(c)) errors.push(`"${c.slice(0, 40)}" is not a valid IP address or range.`);
  v.ipAllow = ips;
  const doms = Array.isArray(input.domainAllow) ? input.domainAllow.map((x) => String(x).trim().toLowerCase().replace(/^@/, "")).filter(Boolean) : [];
  if (doms.length > LIMITS.domainEntries) errors.push(`At most ${LIMITS.domainEntries} email domains.`);
  for (const d of doms) if (!DOMAIN.test(d)) errors.push(`"${d.slice(0, 40)}" is not a valid email domain.`);
  v.domainAllow = [...new Set(doms)];
  v.deviceBinding = input.deviceBinding === "first-use" ? "first-use" : null;
  if (input.deviceBinding && input.deviceBinding !== "first-use") errors.push('deviceBinding must be "first-use" or empty.');
  v.notifyOnAccess = input.notifyOnAccess === true;
  v.watermark = input.watermark === true;
  v.label = text(input.label, LIMITS.labelMax) || null;
  v.note = text(input.note, LIMITS.noteMax) || null;
  const mgr = Array.isArray(input.managerEmails) ? [...new Set(input.managerEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : [];
  if (mgr.length > LIMITS.managers) errors.push(`At most ${LIMITS.managers} delegated managers.`);
  for (const e of mgr) if (!EMAIL.test(e)) errors.push(`"${e.slice(0, 40)}" is not a valid email address.`);
  v.managerEmails = mgr;
  return errors.length ? { errors } : { value: v };
}

// ------------------------------------------------------------------------------------------------ passwords

/** scrypt, per-link random salt, self-describing so parameters can change later. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const key = await scrypt(String(password), salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const key = Buffer.from(keyB64, "base64");
    const got = await scrypt(String(password ?? ""), Buffer.from(saltB64, "base64"), key.length, { N: Number(N), r: Number(r), p: Number(p) });
    return got.length === key.length && timingSafeEqual(got, key);
  } catch { return false; }
}

// ------------------------------------------------------------------------------------------------ status + access

export function shareStatus(share, now = Date.now()) {
  if (share.revokedAt) return "revoked";
  if (new Date(share.expiresAt).getTime() <= now) return "expired";
  if (share.maxUses != null && share.useCount >= share.maxUses) return "exhausted";
  if (share.maxDownloads != null && (share.downloadCount || 0) >= share.maxDownloads) return "exhausted";
  return "active";
}

const GENERIC_FORBIDDEN = "This link cannot be opened from here.";

/**
 * The access decision, in a fixed order. `ctx` = { now, ip, deviceId, email, emailVerified, passwordChecked }:
 *   passwordChecked: undefined (not tried) | true | false (the caller verified it, since hashing is async)
 * Returns { allow: true } or { allow: false, status, error, needs?: "password"|"email" }.
 * Order is deliberate: dead links first (410), then the lockout (429), then location/device (one generic 403 so the response does not
 * say which rule failed), then what the visitor still has to provide (401 + needs).
 */
export function evaluateShareAccess(share, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const st = shareStatus(share, now);
  if (st === "revoked") return { allow: false, status: 410, error: "This link has been revoked." };
  if (st === "expired") return { allow: false, status: 410, error: "This link has expired." };
  if (st === "exhausted") return { allow: false, status: 410, error: "This link has reached its limit." };
  if (share.lockedUntil && new Date(share.lockedUntil).getTime() > now) return { allow: false, status: 429, error: "Too many wrong passwords. Try again later." };
  if (share.ipAllow?.length && !ipMatchesAny(ctx.ip, share.ipAllow)) return { allow: false, status: 403, error: GENERIC_FORBIDDEN };
  if (share.deviceBinding === "first-use" && share.boundDeviceId && share.boundDeviceId !== ctx.deviceId) return { allow: false, status: 403, error: GENERIC_FORBIDDEN };
  if (share.domainAllow?.length) {
    if (!ctx.email) return { allow: false, status: 401, error: "Enter your work email address to open this link.", needs: "email" };
    const domain = String(ctx.email).split("@")[1]?.toLowerCase();
    if (!domain || !share.domainAllow.includes(domain)) return { allow: false, status: 403, error: GENERIC_FORBIDDEN };
    if (!ctx.emailVerified) return { allow: false, status: 401, error: "Enter the code we emailed you.", needs: "code" };
  }
  if (share.passwordHash) {
    if (ctx.passwordChecked === undefined) return { allow: false, status: 401, error: "This link is protected by a password.", needs: "password" };
    if (ctx.passwordChecked === false) return { allow: false, status: 401, error: "That password is not correct.", needs: "password", wrongPassword: true };
  }
  return { allow: true };
}

/** What the secure viewer stamps on every page for a watermarked share: who and when, never anything secret. */
export function watermarkText({ email, ip, now = Date.now(), label }) {
  const who = email || "guest";
  const when = new Date(now).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return [label, who, ip ? String(ip).slice(0, 45) : null, when].filter(Boolean).join(" | ").slice(0, 160);
}

export const publicShareView = (s, now = Date.now()) => ({
  shareId: String(s._id), kind: s.kind || "link", permission: s.permission || "download", label: s.label || null, note: s.note || null,
  createdByEmail: s.createdByEmail, createdAt: s.createdAt, expiresAt: s.expiresAt,
  maxUses: s.maxUses ?? null, useCount: s.useCount || 0, maxDownloads: s.maxDownloads ?? null, downloadCount: s.downloadCount || 0,
  passwordProtected: !!s.passwordHash, ipRestricted: !!s.ipAllow?.length, domainRestricted: s.domainAllow?.length ? s.domainAllow : null,
  deviceBound: s.deviceBinding === "first-use", notifyOnAccess: !!s.notifyOnAccess, watermark: !!s.watermark, oneTime: !!s.oneTime,
  managerEmails: s.managerEmails || [], lastAccessAt: s.lastAccessAt || null, revokedAt: s.revokedAt || null, status: shareStatus(s, now),
  v: s.v || 1,
});
