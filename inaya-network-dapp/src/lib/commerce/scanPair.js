// src/lib/commerce/scanPair.js -- Inaya Commerce: a phone as a wireless barcode scanner for a computer till (post-SOW,
// beta). The till shows a QR code; the phone opens it (no sign-in on the phone), scans with its camera, and every code it
// reads appears in the till's search box exactly as a USB scanner would type it.
//
// The QR carries a random 192-bit pairing key; only its SHA-256 is stored. The key can do ONE thing: add barcode text
// (printable, up to 64 characters) to that one till's scan list, for 12 hours or until the till ends the pairing. It can't
// read anything, sell, or see prices. Rate-limited; the till fetches new codes with its normal signed-in session.
import { randomBytes, createHash } from "node:crypto";
import { ccol, ensureCommerceIndexes, fail, nowIso, oid, sid, commerceAccess, audit } from "./store.js";

export const PAIR_KIND = "c_scan_pair";
const TTL_MS = 12 * 60 * 60 * 1000; const KEEP = 100;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
let idx = null;
async function ensureIdx() {
  await ensureCommerceIndexes(); if (idx) return idx;
  idx = (async () => { const c = await ccol(); await c.createIndex({ kind: 1, tokenHash: 1 }, { unique: true, partialFilterExpression: { kind: PAIR_KIND }, name: "c_scan_pair_token" }); })().catch((e) => { idx = null; throw e; });
  return idx;
}

export async function createScanPair({ orgId, membership, actorEmail, registerId = null }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  await ensureIdx(); const c = await ccol(); const token = randomBytes(24).toString("base64url"); const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const r = await c.insertOne({ orgId: oid(orgId), kind: PAIR_KIND, tokenHash: hash(token), createdBy: actorEmail, registerId: registerId ? oid(registerId) : null, active: true, seq: 0, codes: [], phoneSeenAt: null, createdAt: nowIso(), expiresAt });
  await audit({ orgId, actorEmail, recordType: "COMMERCE_SCANNER", recordId: r.insertedId, action: "PHONE_SCANNER_PAIRED", newState: { registerId: sid(registerId), expiresAt } });
  return { pairId: sid(r.insertedId), token, expiresAt };
}

/** Public (the phone): adds one code. */
export async function pushScan({ token, code }) {
  const t = String(token || ""); if (!/^[A-Za-z0-9_-]{30,40}$/.test(t)) return fail("This scanner link is not valid. Scan the QR code on the till again.", 404, "PAIR_INVALID");
  const text = String(code ?? "").replace(/[\r\n\t]/g, "").trim();
  if (!text || text.length > 64 || !/^[\x20-\x7e]+$/.test(text)) return fail("That code can't be sent to the till.", 400, "CODE");
  await ensureIdx(); const c = await ccol(); const h = hash(t);
  try { const { checkRateLimit } = await import("../rateLimit.js"); await checkRateLimit({ action: "pos_phone_scan", key: h, max: 240, windowMs: 60000 }); }
  catch (e) { if (/Too many/.test(e?.message || "")) return fail("Scanning too fast; wait a moment.", 429, "RATE"); throw e; }
  const now = nowIso();
  const r = await c.findOneAndUpdate({ kind: PAIR_KIND, tokenHash: h, active: true, expiresAt: { $gt: now } }, { $inc: { seq: 1 }, $set: { phoneSeenAt: now } }, { returnDocument: "after", projection: { seq: 1 } });
  if (!r) return fail("This phone is no longer connected to the till. Scan the QR code on the till again.", 410, "PAIR_ENDED");
  await c.updateOne({ _id: r._id }, { $push: { codes: { $each: [{ seq: r.seq, code: text, at: now }], $slice: -KEEP } } });
  return { ok: true, seq: r.seq };
}
/** Public (the phone): is the pairing still open? */
export async function pairStatus({ token }) {
  const t = String(token || ""); if (!/^[A-Za-z0-9_-]{30,40}$/.test(t)) return fail("Not valid.", 404, "PAIR_INVALID");
  await ensureIdx(); const c = await ccol(); const now = nowIso();
  const r = await c.findOneAndUpdate({ kind: PAIR_KIND, tokenHash: hash(t), active: true, expiresAt: { $gt: now } }, { $set: { phoneSeenAt: now } }, { projection: { expiresAt: 1 } });
  return r ? { ok: true, expiresAt: r.expiresAt } : fail("This phone is no longer connected to the till.", 410, "PAIR_ENDED");
}

/** The till: codes after `after`. */
export async function pollScans({ orgId, membership, pairId, after = 0 }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const p = await c.findOne({ _id: oid(pairId), orgId: oid(orgId), kind: PAIR_KIND }, { projection: { codes: 1, seq: 1, active: 1, expiresAt: 1, phoneSeenAt: 1 } });
  if (!p) return fail("Pairing not found.", 404);
  const a = Number(after) || 0;
  return { active: p.active && p.expiresAt > nowIso(), seq: p.seq, phoneSeenAt: p.phoneSeenAt, codes: (p.codes || []).filter((x) => x.seq > a).map((x) => ({ seq: x.seq, code: x.code })) };
}
export async function endScanPair({ orgId, membership, actorEmail, pairId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const r = await c.updateOne({ _id: oid(pairId), orgId: oid(orgId), kind: PAIR_KIND }, { $set: { active: false, endedAt: nowIso(), endedBy: actorEmail } });
  if (!r.matchedCount) return fail("Pairing not found.", 404);
  return { ok: true };
}
