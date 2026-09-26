// src/lib/identity/credentials.js
//
// SOW §21, §25, §36: service credentials for Rewst, RMM agents, HR/PSA automations and MSPs.
//   * bearer tokens `idc_...`: shown once, stored only as a SHA-256 hash, scoped to named capabilities, expiring, revocable,
//     rotatable, with a last-used stamp;
//   * an ORG credential acts on exactly one organization (and optionally exactly one provider, which SCIM requires);
//   * an MSP credential belongs to an MSP organization and may act only on customer organizations that are LINKED to it (the customer
//     accepted the link) and that the credential lists. The customer is named per request and re-verified every time;
//   * every refusal is audited and never mutates anything.
// Secrets never appear in any response other than the one that creates or rotates the credential.

import { emitIdentityEvent } from "./outbound.js";
import { toObjectId } from "../orgs.js";
import { checkRateLimit } from "../rateLimit.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { fail, nowIso, sha256, newToken, normEmail } from "./common.js";
import { audit } from "./record.js";

export const CREDENTIAL_SCOPES = ["identity:read", "identity:audit", "identity:provision", "identity:revoke", "identity:reconcile", "identity:mapping", "identity:scim"];

const view = (c) => ({ credentialId: String(c._id), kind: c.kind, label: c.label, prefix: c.prefix, scopes: c.scopes, providerId: c.providerId ? String(c.providerId) : null, customerOrgIds: c.customerOrgIds === "*" ? "*" : (c.customerOrgIds || []).map(String), expiresAt: c.expiresAt, createdAt: c.createdAt, createdBy: c.createdBy, revokedAt: c.revokedAt || null, lastUsedAt: c.lastUsedAt || null });

export async function createCredential({ orgId, kind = "org", label, scopes, expiresInDays = 180, providerId = null, customerOrgIds = null, actorEmail }) {
  await ensureIdentityIndexes();
  if (!["org", "msp"].includes(kind)) return fail("kind must be org or msp.");
  const list = Array.isArray(scopes) && scopes.length ? [...new Set(scopes)] : null;
  if (!list || list.some((s) => !CREDENTIAL_SCOPES.includes(s))) return fail(`scopes must be a non-empty list from: ${CREDENTIAL_SCOPES.join(", ")}.`);
  if (list.includes("identity:scim") && kind === "org" && !providerId) return fail("A SCIM credential must be bound to one provider (providerId).");
  const days = Math.min(365, Math.max(1, Math.floor(Number(expiresInDays) || 180)));
  const { identityCredentials, identityProviders, identityMspLinks } = await getIdentityCollections();
  let pid = null;
  if (providerId) { try { pid = toObjectId(providerId); } catch { return fail("providerId is invalid."); } const p = await identityProviders.findOne({ _id: pid, orgId: toObjectId(orgId) }); if (!p) return fail("Provider not found in this organization.", 404); }
  let cust = null;
  if (kind === "msp") {
    if (customerOrgIds === "*") cust = "*";
    else {
      if (!Array.isArray(customerOrgIds) || !customerOrgIds.length) return fail("An MSP credential must list customerOrgIds (or \"*\" for every linked customer).");
      cust = [];
      for (const id of customerOrgIds) { let oid; try { oid = toObjectId(id); } catch { return fail("customerOrgIds contains an invalid id."); } if (!(await identityMspLinks.findOne({ mspOrgId: toObjectId(orgId), customerOrgId: oid, status: "ACTIVE" }))) return fail(`Customer ${id} is not linked to this MSP (the customer must accept the link first).`, 403); cust.push(oid); }
    }
  }
  const raw = `idc_${newToken(32)}`;
  const doc = { kind, orgId: kind === "org" ? toObjectId(orgId) : null, mspOrgId: kind === "msp" ? toObjectId(orgId) : null, tokenHash: sha256(raw), prefix: raw.slice(0, 12), label: String(label || "Identity integration").slice(0, 80), scopes: list, providerId: pid, customerOrgIds: cust, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), createdBy: normEmail(actorEmail), createdAt: nowIso(), revokedAt: null, lastUsedAt: null };
  doc._id = (await identityCredentials.insertOne(doc)).insertedId;
  await audit({ orgId, action: "IDENTITY_CREDENTIAL_CREATED", actorEmail, metadata: { credentialId: String(doc._id), kind, scopes: list, providerBound: !!pid, expiresAt: doc.expiresAt } });
  return { credential: view(doc), token: raw, note: "Save this token now: it is shown once." };
}

export async function listCredentials({ orgId }) {
  const { identityCredentials } = await getIdentityCollections();
  const oid = toObjectId(orgId);
  return { credentials: (await identityCredentials.find({ $or: [{ orgId: oid }, { mspOrgId: oid }] }).sort({ createdAt: -1 }).toArray()).map(view) };
}

export async function revokeCredential({ orgId, credentialId, actorEmail }) {
  const { identityCredentials } = await getIdentityCollections();
  let id; try { id = toObjectId(credentialId); } catch { return fail("Credential not found.", 404); }
  const oid = toObjectId(orgId);
  const r = await identityCredentials.findOneAndUpdate({ _id: id, $or: [{ orgId: oid }, { mspOrgId: oid }], revokedAt: null }, { $set: { revokedAt: nowIso(), revokedBy: normEmail(actorEmail) } }, { returnDocument: "after" });
  if (!r) return fail("Credential not found, or already revoked.", 404);
  await audit({ orgId, action: "IDENTITY_CREDENTIAL_REVOKED", actorEmail, metadata: { credentialId: String(id) } });
  await emitIdentityEvent({ orgId, type: "credential.revoked", subject: null, data: { credentialId: String(id), prefix: r.prefix || null } });
  return { revoked: true };
}

export async function rotateCredential({ orgId, credentialId, actorEmail }) {
  const { identityCredentials } = await getIdentityCollections();
  let id; try { id = toObjectId(credentialId); } catch { return fail("Credential not found.", 404); }
  const oid = toObjectId(orgId);
  const old = await identityCredentials.findOne({ _id: id, $or: [{ orgId: oid }, { mspOrgId: oid }], revokedAt: null });
  if (!old) return fail("Credential not found, or already revoked.", 404);
  const raw = `idc_${newToken(32)}`;
  const doc = { ...old, _id: undefined, tokenHash: sha256(raw), prefix: raw.slice(0, 12), createdAt: nowIso(), createdBy: normEmail(actorEmail), lastUsedAt: null, rotatedFrom: String(old._id) };
  delete doc._id;
  doc._id = (await identityCredentials.insertOne(doc)).insertedId;
  await identityCredentials.updateOne({ _id: old._id }, { $set: { revokedAt: nowIso(), revokedBy: normEmail(actorEmail), revokedReason: "rotated" } });
  await audit({ orgId, action: "IDENTITY_CREDENTIAL_ROTATED", actorEmail, metadata: { credentialId: String(doc._id), previous: String(old._id) } });
  return { credential: view(doc), token: raw, note: "Save this token now: it is shown once. The previous token stopped working." };
}

/**
 * Authenticates a service request. Returns { ctx } or { error, status }.
 * ctx = { orgId, credentialId, actor, mspOrgId|null, scopes, providerId|null }. Never reveals whether a token exists.
 */
export async function authenticateCredential(req, { scope = null, requestedOrgId = null } = {}) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return fail("Missing credential.", 401);
  const raw = h.slice(7).trim();
  if (!raw.startsWith("idc_")) return fail("Invalid, expired or revoked credential.", 401);
  const { identityCredentials, identityMspLinks } = await getIdentityCollections();
  const cred = await identityCredentials.findOne({ tokenHash: sha256(raw), revokedAt: null });
  if (!cred || new Date(cred.expiresAt).getTime() <= Date.now()) return fail("Invalid, expired or revoked credential.", 401);
  if (scope && !cred.scopes.includes(scope)) return fail(`This credential does not have the ${scope} scope.`, 403, { reasonCode: "SCOPE_MISSING" });
  try { await checkRateLimit({ action: "identity-api", key: String(cred._id), max: 600, windowMs: 60000 }); } catch { return fail("Rate limit exceeded. Slow down and retry shortly.", 429, { reasonCode: "RATE_LIMITED" }); }
  identityCredentials.updateOne({ _id: cred._id }, { $set: { lastUsedAt: nowIso() } }).catch(() => {});
  const home = cred.orgId || cred.mspOrgId;
  const deny = async (why, target) => { await audit({ orgId: home, action: "IDENTITY_CROSS_TENANT_DENIED", actorEmail: `cred:${cred.prefix}`, metadata: { reason: why, requestedOrganization: target ? String(target) : null, credentialId: String(cred._id) } }); return fail("This credential cannot act on that organization.", 403, { reasonCode: "ORGANIZATION_NOT_ALLOWED" }); };

  if (cred.kind === "org") {
    if (requestedOrgId && String(requestedOrgId) !== String(cred.orgId)) return deny("organization mismatch", requestedOrgId);
    return { ctx: { orgId: String(cred.orgId), credentialId: String(cred._id), actor: `cred:${cred.prefix}`, mspOrgId: null, scopes: cred.scopes, providerId: cred.providerId ? String(cred.providerId) : null } };
  }
  if (!requestedOrgId) return fail("An MSP credential must name the customer organization (X-Inaya-Organization).", 400, { reasonCode: "ORGANIZATION_REQUIRED" });
  let cid; try { cid = toObjectId(requestedOrgId); } catch { return fail("The organization id is invalid.", 400); }
  const link = await identityMspLinks.findOne({ mspOrgId: cred.mspOrgId, customerOrgId: cid, status: "ACTIVE" });
  const listed = cred.customerOrgIds === "*" || (cred.customerOrgIds || []).some((x) => String(x) === String(cid));
  if (!link || !listed) return deny(!link ? "no active link" : "customer not listed on the credential", cid);
  return { ctx: { orgId: String(cid), credentialId: String(cred._id), actor: `msp:${cred.prefix}`, mspOrgId: String(cred.mspOrgId), scopes: cred.scopes, providerId: null } };
}
