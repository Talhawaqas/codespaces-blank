// test/_identity-fixtures.mjs -- real-database fixtures for the Identity Integration tests. Real MongoDB, real membership rules,
// real audit chain and Evidence Graph. Only the external world (Entra/AD/Rewst/Graph) is played by the tests themselves.

import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import { getIdentityCollections, ensureIdentityIndexes } from "../src/lib/identity/db.js";
import { createProvider, getProviderById } from "../src/lib/identity/providers.js";
import { createMapping } from "../src/lib/identity/mapping.js";
import { validateCanonical, signPayload } from "../src/lib/identity/normalize.js";
import mongoClientPromise from "../src/lib/mongodb.js";

export const RUN = randomBytes(3).toString("hex");
export const created = { orgIds: [], tenants: [] };
export let c; export let ic;
if (!process.env.INTEGRATION_ENCRYPTION_KEY) process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");

export async function setup() { await ensureOrgIndexes(); await ensureIdentityIndexes(); c = await getOrgCollections(); ic = await getIdentityCollections(); return { c, ic }; }

const now = () => new Date().toISOString();

/** An organization with an owner, an admin, departments Finance/Legal, a project in each, and an Entra provider with group mappings. */
export async function makeIdentityOrg(label, { kind = "entra", policy = {}, mappings = true } = {}) {
  const orgId = (await c.orgs.insertOne({ name: `idn-${RUN}-${label}`, createdAt: now() })).insertedId;
  created.orgIds.push(orgId);
  const dept = async (name) => (await c.departments.insertOne({ orgId, name, createdAt: now() })).insertedId;
  const finance = await dept("Finance"); const legal = await dept("Legal");
  const project = async (departmentId, name) => (await c.projects.insertOne({ orgId, departmentId, name, createdAt: now(), createdByEmail: "x" })).insertedId;
  const pFin = await project(finance, "Ledger"); const pLegal = await project(legal, "Contracts");
  const member = async (k, extra = {}) => { const email = `idn-${RUN}-${label}-${k}@example.com`; await c.orgMembers.insertOne({ orgId, email, role: "member", departmentIds: [], status: "active", invitedAt: now(), joinedAt: now(), ...extra }); return email; };
  const owner = await member("owner", { role: "owner" });
  const admin = await member("admin", { role: "admin" });
  const tenant = `tenant-${RUN}-${label}`; created.tenants.push(tenant);
  const r = await createProvider({ orgId, kind, providerTenantId: tenant, name: `${kind} ${label}`, policy, actorEmail: owner });
  if (r.error) throw new Error(r.error);
  const provider = await getProviderById(r.provider.providerId);
  const maps = {};
  if (mappings) {
    maps.finance = (await createMapping({ orgId, providerId: r.provider.providerId, body: { name: "Finance group", match: { type: "group", value: "Inaya-Finance" }, grants: [{ kind: "department", value: "dept:Finance" }, { kind: "financeRole", value: "staff" }, { kind: "project", value: "project:Ledger" }] }, actorEmail: owner })).mapping;
    maps.legal = (await createMapping({ orgId, providerId: r.provider.providerId, body: { name: "Legal group", match: { type: "group", value: "Inaya-Legal" }, grants: [{ kind: "department", value: "dept:Legal" }, { kind: "project", value: "project:Contracts" }] }, actorEmail: owner })).mapping;
  }
  return { orgId, oid: String(orgId), owner, admin, finance, legal, pFin, pLegal, tenant, provider, providerId: r.provider.providerId, secret: r.signingSecret, member, maps };
}

let seq = 0;
/** A canonical, validated identity event. `t` is seconds offset from a fixed base so ordering is explicit in tests. */
export function ev(org, { type = "user.created", id = `ext-${RUN}-1`, t = 0, email, groups = ["Inaya-Finance"], enabled, name = "Alice Example", extra = {}, tenant = org.tenant, eventId, sequence } = {}) {
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  const body = { eventId: eventId || `evt-${RUN}-${++seq}`, type, tenantId: tenant, occurredAt: new Date(base + t * 1000).toISOString(), ...(sequence !== undefined ? { sequence } : {}), subject: { externalId: id, upn: email, email, displayName: name, department: "Finance", groups, ...(enabled !== undefined ? { accountEnabled: enabled } : {}), ...extra } };
  const v = validateCanonical(body, { now: base + 86400000 * 400 });
  if (v.error) throw new Error(v.error);
  return v.event;
}

export const signedHeaders = (secret, raw, ts = Math.floor(Date.now() / 1000)) => ({ "x-inaya-timestamp": String(ts), "x-inaya-signature": signPayload(secret, String(ts), raw) });
export const cookieFor = async (email) => (await createSession(email)).sessionToken;

export async function cleanup() {
  const ids = created.orgIds;
  if (ids.length) {
    for (const k of ["identityProviders", "identityExternalUsers", "identityMappings", "identityGrants", "identityEvents", "identityCredentials", "identityMspLinks", "identityMspInvites", "identityMspAssignments", "identityReviews", "identityReviewItems", "identityDriftReports", "identityJobs", "identitySnapshots", "identityRevocations", "identityRemediations", "identityRuns", "identityWebhooks", "identityDeliveries"]) { try { await ic[k].deleteMany({ $or: [{ orgId: { $in: ids } }, { mspOrgId: { $in: ids } }, { customerOrgId: { $in: ids } }] }); } catch { /* ignore */ } }
    try { await ic.identityProviders.deleteMany({ providerTenantId: { $in: created.tenants } }); } catch { /* ignore */ }
    for (const k of ["orgMembers", "departments", "projects", "projectMembers", "documentPermissions", "documentShares", "apiKeys", "orgActivity", "auditChainEntries", "auditChainHeads", "businessEvents", "aiActionRequests", "tasks", "orgDocuments", "orgs"]) { try { await c[k].deleteMany(k === "orgs" ? { _id: { $in: ids } } : { orgId: { $in: ids } }); } catch { /* ignore */ } }
    try { await ic.db.collection("notifications").deleteMany({ orgId: { $in: ids } }); await ic.db.collection("s3_credentials").deleteMany({ ownerType: "org", ownerId: { $in: ids.map(String) } }); } catch { /* ignore */ }
  }
  try { await ic.db.collection("sessions").deleteMany({ email: new RegExp(`^idn-${RUN}-`) }); } catch { /* ignore */ }
  await (await mongoClientPromise).close();
}
