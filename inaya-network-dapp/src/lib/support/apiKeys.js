// src/lib/support/apiKeys.js
//
// SOW §28, §29, §57: keys for the public support API. They live in the existing `api_keys` collection (same
// hashing, shown once, revocable) with kind "support", and add what the SOW asks for: least-privilege scopes,
// an expiry, and an optional binding to ONE customer. A customer-bound key can only ever act as, and see the
// tickets of, that customer. The legacy requireApiKey() refuses support keys, so a support key can never open an
// owner-level route.

import { getOrgCollections, toObjectId, hashToken, generateToken } from "../orgs.js";
import { checkRateLimit } from "../rateLimit.js";
import { fail, nowIso, normEmail, isEmail } from "./common.js";
import { audit } from "./record.js";
import { getSettings } from "./settings.js";

export const API_SCOPES = ["tickets:read", "tickets:write", "attachments:write", "knowledge:read", "invoices:read", "ideas:write", "ai:chat", "events:read", "queues:read", "customers:read"];

export async function createSupportApiKey({ orgId, label, scopes, expiresInDays = 365, customerEmail = null, actorEmail }) {
  const list = Array.isArray(scopes) && scopes.length ? [...new Set(scopes)] : null;
  if (!list || list.some((s) => !API_SCOPES.includes(s))) return fail(`scopes must be a non-empty list from: ${API_SCOPES.join(", ")}.`);
  const days = Math.min(730, Math.max(1, Math.floor(Number(expiresInDays) || 365)));
  let email = null;
  if (customerEmail) { email = normEmail(customerEmail); if (!isEmail(email)) return fail("customerEmail is not a valid address."); }
  const { apiKeys } = await getOrgCollections();
  const rawKey = `inaya_sup_${generateToken()}`;
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), kind: "support", tokenHash: hashToken(rawKey), prefix: rawKey.slice(0, 14), label: String(label || "Support API key").slice(0, 80), scopes: list, customerEmail: email, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), createdByEmail: actorEmail, createdAt: now, revokedAt: null, lastUsedAt: null };
  const r = await apiKeys.insertOne(doc);
  await audit({ orgId, action: "SUPPORT_API_KEY_CREATED", actorEmail, metadata: { apiKeyId: String(r.insertedId), scopes: list, customerBound: !!email, expiresAt: doc.expiresAt } });
  return { apiKeyId: String(r.insertedId), rawKey, prefix: doc.prefix, label: doc.label, scopes: list, customerEmail: email, expiresAt: doc.expiresAt, note: "Save this key now: it is shown once." };
}

export async function listSupportApiKeys({ orgId }) {
  const { apiKeys } = await getOrgCollections();
  const rows = await apiKeys.find({ orgId: toObjectId(orgId), kind: "support" }).sort({ createdAt: -1 }).toArray();
  return { apiKeys: rows.map((k) => ({ apiKeyId: String(k._id), label: k.label, prefix: k.prefix, scopes: k.scopes, customerEmail: k.customerEmail || null, expiresAt: k.expiresAt, createdAt: k.createdAt, createdByEmail: k.createdByEmail, revokedAt: k.revokedAt, lastUsedAt: k.lastUsedAt })) };
}

export async function revokeSupportApiKey({ orgId, apiKeyId, actorEmail }) {
  const { apiKeys } = await getOrgCollections();
  let id; try { id = toObjectId(apiKeyId); } catch { return fail("API key not found.", 404); }
  const r = await apiKeys.findOneAndUpdate({ _id: id, orgId: toObjectId(orgId), kind: "support", revokedAt: null }, { $set: { revokedAt: nowIso() } }, { returnDocument: "after" });
  if (!r) return fail("API key not found, or already revoked.", 404);
  await audit({ orgId, action: "SUPPORT_API_KEY_REVOKED", actorEmail, metadata: { apiKeyId: String(id) } });
  return { revoked: true };
}

/**
 * Resolves the bearer key of a public-API request. Returns { ctx } or { error, status }.
 * ctx = { orgId, settings, scopes, customerEmail|null, keyId, actor }. The organization comes ONLY from the key.
 * Rate limited per key; unknown / expired / revoked keys are indistinguishable (401).
 */
export async function requireSupportApiKey(req, scope) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return fail("Missing API key.", 401);
  const raw = h.slice(7).trim();
  if (!raw.startsWith("inaya_sup_")) return fail("Invalid, expired or revoked API key.", 401);
  const { apiKeys } = await getOrgCollections();
  const key = await apiKeys.findOne({ tokenHash: hashToken(raw), kind: "support", revokedAt: null });
  if (!key || new Date(key.expiresAt).getTime() <= Date.now()) return fail("Invalid, expired or revoked API key.", 401);
  if (scope && !(key.scopes || []).includes(scope)) return fail(`This key does not have the ${scope} scope.`, 403, { reasonCode: "SCOPE_MISSING" });
  const settings = await getSettings(key.orgId);
  try { await checkRateLimit({ action: "support-api", key: String(key._id), max: settings.rate.apiPerMinute, windowMs: 60000 }); }
  catch { return fail("Rate limit exceeded. Slow down and retry shortly.", 429, { reasonCode: "RATE_LIMITED" }); }
  apiKeys.updateOne({ _id: key._id }, { $set: { lastUsedAt: nowIso() } }).catch(() => {});
  return { ctx: { orgId: String(key.orgId), settings, scopes: key.scopes, customerEmail: key.customerEmail || null, keyId: String(key._id), actor: { type: "api", email: key.customerEmail || `api:${key.prefix}` } } };
}
