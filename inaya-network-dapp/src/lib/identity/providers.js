// src/lib/identity/providers.js
//
// SOW §8, §36: identity providers and the explicit tenant -> organization binding.
//   * a provider record binds ONE external tenant of ONE kind (entra / ad / hr / psa / rmm / scim / generic) to ONE
//     Inaya organization. The pair (kind, providerTenantId) is unique across all organizations, so the same tenant can
//     never be bound to two organizations, and an organization is never chosen by email-domain similarity;
//   * each provider has a webhook signing secret (shown once, stored encrypted, rotatable);
//   * the provider's policy decides how identities are linked and how lifecycle events are applied.

import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { toObjectId } from "../orgs.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { fail, nowIso, PROVIDER_KINDS, GRANT_KINDS, ROLE_VALUES } from "./common.js";

export const DEFAULT_POLICY = {
  emailLinking: "exact_unique",           // controlled fallback: link by email only when exactly one candidate exists ("off" disables it)
  employeeIdAuthoritative: false,          // treat employeeId as an authoritative key (after the immutable object id)
  defaultGrants: [{ kind: "role", value: "member" }], // applied to a joiner (never "owner")
  removeObsoleteOnMove: true,              // a mover loses external grants that the new state no longer justifies
  restoreOnEnable: "manual_review",        // manual_review | auto | never (an enable event after a revocation)
  sessionRevocation: "if_no_other_active_membership", // or "always"
  revokeCredentialsCreatedByUser: true,
  revokeSharesCreatedByUser: true,
  requireApprovalForPrivileged: true,      // admin (and any mapping flagged privileged) goes through Controlled Actions
  autoRevokeDisabledOnDrift: false,        // reconciliation only reports by default
  notify: true,
};

export function validatePolicy(p) {
  const errors = [];
  const pol = { ...DEFAULT_POLICY, ...(p && typeof p === "object" ? p : {}) };
  if (!["exact_unique", "off"].includes(pol.emailLinking)) errors.push("emailLinking must be exact_unique or off.");
  if (!["manual_review", "auto", "never"].includes(pol.restoreOnEnable)) errors.push("restoreOnEnable must be manual_review, auto or never.");
  if (!["if_no_other_active_membership", "always"].includes(pol.sessionRevocation)) errors.push("sessionRevocation must be if_no_other_active_membership or always.");
  if (!Array.isArray(pol.defaultGrants) || pol.defaultGrants.length > 20) errors.push("defaultGrants must be a list of up to 20 grants.");
  else for (const g of pol.defaultGrants) errors.push(...validateGrant(g, { allowPrivileged: false }));
  for (const k of ["employeeIdAuthoritative", "removeObsoleteOnMove", "revokeCredentialsCreatedByUser", "revokeSharesCreatedByUser", "requireApprovalForPrivileged", "autoRevokeDisabledOnDrift", "notify"]) if (typeof pol[k] !== "boolean") errors.push(`${k} must be true or false.`);
  return errors.length ? { errors } : { policy: pol };
}

/** A grant an external system may cause. "owner" can never be granted; "admin" is privileged. */
export function validateGrant(g, { allowPrivileged = true } = {}) {
  const errors = [];
  if (!g || typeof g !== "object" || !GRANT_KINDS.includes(g.kind)) return [`grant kind must be one of ${GRANT_KINDS.join(", ")}.`];
  if (typeof g.value !== "string" || !g.value.trim() || g.value.length > 120) return ["grant value is required."];
  if (ROLE_VALUES[g.kind] && !ROLE_VALUES[g.kind].includes(g.value)) errors.push(`${g.kind} must be one of ${ROLE_VALUES[g.kind].join(", ")} ("owner" can never be granted from an external system).`);
  if (g.kind === "role" && g.value === "admin" && !allowPrivileged) errors.push("The admin role is privileged and cannot be a default grant.");
  return errors;
}
export const isPrivilegedGrant = (g) => (g.kind === "role" && g.value === "admin") || g.privileged === true || (["financeRole", "hrRole", "complianceRole", "escrowRole", "storageRole", "supportRole"].includes(g.kind) && g.value === "manager" && g.privileged === true);

const view = (p) => ({ providerId: String(p._id), kind: p.kind, providerTenantId: p.providerTenantId, name: p.name, status: p.status, policy: p.policy, organizationId: String(p.orgId), createdAt: p.createdAt, createdBy: p.createdBy, lastEventAt: p.lastEventAt || null, lastSyncAt: p.lastSyncAt || null, lastError: p.lastError || null, hasSigningSecret: !!p.signingSecretEncrypted, hasGraphCredentials: !!p.graph?.clientSecretEncrypted, graph: p.graph ? { clientId: p.graph.clientId, tenantId: p.graph.tenantId } : null });

export async function createProvider({ orgId, kind, providerTenantId, name, policy, actorEmail }) {
  await ensureIdentityIndexes();
  if (!PROVIDER_KINDS.includes(kind)) return fail(`kind must be one of ${PROVIDER_KINDS.join(", ")}.`);
  const tenant = String(providerTenantId || "").trim();
  if (!/^[A-Za-z0-9._:-]{3,120}$/.test(tenant)) return fail("providerTenantId is required (3-120 characters: letters, numbers . _ : -).");
  const nm = String(name || "").trim().slice(0, 80) || `${kind} ${tenant}`;
  const v = validatePolicy(policy); if (v.errors) return fail(v.errors[0], 400, { errors: v.errors });
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  const { identityProviders } = await getIdentityCollections();
  const secret = `idw_${randomBytes(24).toString("hex")}`;
  const doc = { orgId: toObjectId(orgId), kind, providerTenantId: tenant, name: nm, status: "ACTIVE", policy: v.policy, signingSecretEncrypted: encryptIntegrationSecret(secret), signingSecretAt: nowIso(), createdAt: nowIso(), createdBy: actorEmail, lastEventAt: null, lastSyncAt: null, lastError: null };
  try { doc._id = (await identityProviders.insertOne(doc)).insertedId; }
  catch (err) { if (err?.code === 11000) return fail("That tenant is already bound to an organization. A tenant can belong to only one.", 409, { reasonCode: "TENANT_ALREADY_BOUND" }); throw err; }
  return { provider: view(doc), signingSecret: secret, note: "Save the signing secret now: it is shown once." };
}

export async function listProviders({ orgId }) {
  const { identityProviders } = await getIdentityCollections();
  return { providers: (await identityProviders.find({ orgId: toObjectId(orgId) }).sort({ createdAt: 1 }).toArray()).map(view) };
}

const oidOf = (id) => { try { return new ObjectId(String(id)); } catch { return null; } };
export async function getProvider({ orgId, providerId }) {
  const id = oidOf(providerId); if (!id) return null;
  const { identityProviders } = await getIdentityCollections();
  return identityProviders.findOne({ _id: id, orgId: toObjectId(orgId) });
}
/** Provider by id, WITHOUT an org (webhooks: the provider itself names the organization). */
export async function getProviderById(providerId) {
  const id = oidOf(providerId); if (!id) return null;
  const { identityProviders } = await getIdentityCollections();
  return identityProviders.findOne({ _id: id });
}
export async function resolveByTenant(kind, tenantId) {
  const { identityProviders } = await getIdentityCollections();
  return identityProviders.findOne({ kind, providerTenantId: String(tenantId), status: "ACTIVE" });
}

export async function updateProvider({ orgId, providerId, patch, actorEmail }) {
  const p = await getProvider({ orgId, providerId });
  if (!p) return fail("Provider not found.", 404);
  const set = { updatedAt: nowIso(), updatedBy: actorEmail };
  if (patch.name !== undefined) set.name = String(patch.name).trim().slice(0, 80);
  if (patch.status !== undefined) { if (!["ACTIVE", "DISABLED"].includes(patch.status)) return fail("status must be ACTIVE or DISABLED."); set.status = patch.status; }
  if (patch.policy !== undefined) { const v = validatePolicy({ ...p.policy, ...patch.policy }); if (v.errors) return fail(v.errors[0], 400, { errors: v.errors }); set.policy = v.policy; }
  if (patch.providerTenantId !== undefined && patch.providerTenantId !== p.providerTenantId) return fail("A provider's tenant cannot be changed. Create a new provider instead.", 400);
  if (patch.graph !== undefined) {
    const g = patch.graph;
    if (g === null) set.graph = null;
    else {
      if (!g.clientId || !g.tenantId) return fail("graph needs clientId and tenantId (and the client secret is set with clientSecret).");
      const prev = p.graph || {};
      set.graph = { clientId: String(g.clientId).slice(0, 100), tenantId: String(g.tenantId).slice(0, 100), clientSecretEncrypted: g.clientSecret ? encryptIntegrationSecret(String(g.clientSecret)) : prev.clientSecretEncrypted || null, autoPull: g.autoPull === true, groupIds: Array.isArray(g.groupIds) ? g.groupIds.map((x) => String(x).slice(0, 80)).slice(0, 50) : prev.groupIds || [] };
    }
  }
  const { identityProviders } = await getIdentityCollections();
  await identityProviders.updateOne({ _id: p._id }, { $set: set });
  return { provider: view(await getProvider({ orgId, providerId })) };
}

export async function rotateSigningSecret({ orgId, providerId, actorEmail }) {
  const p = await getProvider({ orgId, providerId });
  if (!p) return fail("Provider not found.", 404);
  const secret = `idw_${randomBytes(24).toString("hex")}`;
  const { identityProviders } = await getIdentityCollections();
  await identityProviders.updateOne({ _id: p._id }, { $set: { signingSecretEncrypted: encryptIntegrationSecret(secret), signingSecretAt: nowIso(), updatedBy: actorEmail } });
  return { signingSecret: secret, note: "Save the signing secret now: it is shown once. The previous secret stopped working." };
}

export async function deleteProvider({ orgId, providerId }) {
  const p = await getProvider({ orgId, providerId });
  if (!p) return fail("Provider not found.", 404);
  const { identityProviders } = await getIdentityCollections();
  // disabled, not deleted: external-identity mappings and the history of runs keep their reference
  await identityProviders.updateOne({ _id: p._id }, { $set: { status: "DISABLED", disabledAt: nowIso() } });
  return { disabled: true };
}

export function signingSecretOf(p) { try { return decryptIntegrationSecret(p.signingSecretEncrypted); } catch { return null; } }
export function graphSecretOf(p) { try { return p.graph?.clientSecretEncrypted ? decryptIntegrationSecret(p.graph.clientSecretEncrypted) : null; } catch { return null; } }
export { view as providerView };
