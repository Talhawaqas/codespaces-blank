// src/lib/api-keys.js
//
// Institutional Trust Infrastructure SOW, Phase 4 — API keys for the new
// public/v1 namespace. Same hash-and-store convention orgs.js already
// uses for sessions/magicLinks (generateToken/hashToken, raw value shown
// exactly once at creation, only the hash ever persisted) — no new
// crypto primitive introduced.
//
// requireApiKey() is the API-key equivalent of requireMembership(): it
// resolves to a SYNTHETIC owner-level membership scoped to the key's own
// bound org, and — critically — the caller's request body/query can never
// override which org a key acts as. A public/v1 route must always use
// the orgId requireApiKey() resolves, never one read from the request.

import { getOrgCollections, toObjectId, hashToken, generateToken } from "./orgs.js";

export async function createApiKey({ orgId, label, actorEmail }) {
  const { apiKeys } = await getOrgCollections();
  const rawKey = `inaya_${generateToken()}`;
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), tokenHash: hashToken(rawKey), label: label || "API key", createdByEmail: actorEmail, createdAt: now, revokedAt: null };
  const { insertedId } = await apiKeys.insertOne(doc);
  // rawKey is returned ONLY here — it is never stored and can't be
  // recovered later, same guarantee a session cookie/magic link gives.
  return { apiKeyId: insertedId.toString(), rawKey, label: doc.label, createdAt: now };
}

export async function revokeApiKey({ orgId, apiKeyId }) {
  const { apiKeys } = await getOrgCollections();
  const result = await apiKeys.findOneAndUpdate(
    { _id: toObjectId(apiKeyId), orgId: toObjectId(orgId), revokedAt: null },
    { $set: { revokedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!result) return { error: "API key not found, or already revoked.", status: 404 };
  return { revoked: true };
}

export async function listApiKeys({ orgId }) {
  const { apiKeys } = await getOrgCollections();
  const rows = await apiKeys.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).toArray();
  // Never returns tokenHash — even the hash isn't something a client needs.
  return { apiKeys: rows.map((k) => ({ apiKeyId: k._id.toString(), label: k.label, createdByEmail: k.createdByEmail, createdAt: k.createdAt, revokedAt: k.revokedAt })) };
}

/** The API-key equivalent of requireMembership(req, orgId) — but there is
 *  no orgId parameter here on purpose: the key itself IS the org
 *  assertion, so a route calling this can never be tricked into acting on
 *  a different org than the one the presented key actually belongs to. */
export async function requireApiKey(req) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { error: "Missing API key.", status: 401 };
  const rawKey = authHeader.slice("Bearer ".length).trim();

  const { apiKeys } = await getOrgCollections();
  const key = await apiKeys.findOne({ tokenHash: hashToken(rawKey), revokedAt: null });
  if (!key) return { error: "Invalid or revoked API key.", status: 401 };

  return { orgId: key.orgId.toString(), membership: { role: "owner" } };
}
