// src/lib/rds/instances.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream A control plane. Owns the Inaya-side
// record (name, provider, providerRef, status, department scoping, audit, Evidence Graph) and delegates every
// real database operation to the configured provider (rds/providerRegistry.js) -- this file never talks to
// Supabase's API directly, so adding a second provider later never touches this file's callers.
//
// The database password is never stored in plaintext: it is encrypted with the SAME reversible AES-256-GCM
// scheme this codebase already uses for third-party secrets (integrationCrypto.js, keyed by
// INTEGRATION_ENCRYPTION_KEY, already configured in production -- see project_workflow_automations memory).
// It is decrypted only for the single provisioning call and is never logged, never returned by any read path.

import { toObjectId, canManageOrg } from "../orgs.js";
import { encryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { getRdsCollections, ensureRdsIndexes } from "./db.js";
import { getProvider, listAvailableProviders } from "./providerRegistry.js";
import { fail, nowIso } from "../docIntelligence/common.js";
import { audit, event, link, notify } from "./record.js";

export const instanceView = (i) => ({ instanceId: String(i._id), name: i.name, provider: i.provider, engine: i.engine, providerRef: i.providerRef, region: i.region || null, status: i.status, highAvailability: !!i.highAvailability, createdAt: i.createdAt, updatedAt: i.updatedAt });

export function listConfiguredProviders() { return listAvailableProviders(); }

/**
 * Provisions a real database instance through the named provider. `dbPassword` is used once, sent to the
 * provider, then stored only in its encrypted form -- never in plaintext, never logged. Owner/admin only:
 * provisioning a real, potentially billable external resource is not a plain-member action.
 */
export async function provisionInstance({ orgId, membership, actorEmail, providerName, name, organizationSlug, region, dbPassword, highAvailability = false }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can provision a database instance.", 403);
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server -- no database credential can be stored until it is.", 500);
  const mod = getProvider(providerName);
  if (!mod || !mod.isConfigured()) return fail(`Provider "${providerName}" is not configured on this server.`, 400);
  await ensureRdsIndexes();
  const c = await getRdsCollections(); const oid = toObjectId(orgId);
  const existing = await c.rdsInstances.findOne({ orgId: oid, name });
  if (existing) return fail("An instance with this name already exists.", 409);

  const engineCheck = await mod.validateEngine({ engine: "postgres" });
  if (!engineCheck.ok) return fail(engineCheck.error, 400);
  const r = await mod.provision({ organizationSlug, name, region, dbPassword, highAvailability });
  if (!r.ok) return fail(r.error || "Provisioning failed.", r.status && r.status >= 400 && r.status < 500 ? r.status : 502);

  const now = nowIso();
  const doc = { orgId: oid, name, provider: providerName, engine: "postgres", providerRef: r.instance.providerRef, region: r.instance.region, status: r.instance.status || "provisioning", highAvailability: !!highAvailability, dbPasswordEnc: encryptIntegrationSecret(dbPassword), createdAt: now, updatedAt: now, createdBy: actorEmail };
  doc._id = (await c.rdsInstances.insertOne(doc)).insertedId;
  await event({ orgId, type: "INSTANCE_PROVISIONED", recordId: doc._id, actorEmail, metadata: { name, provider: providerName, providerRef: r.instance.providerRef, region: r.instance.region } });
  link({ orgId, subjectId: doc._id, type: "EXECUTED_AS", targetType: "RDS_PROVIDER", targetId: doc._id, note: `${providerName}:${r.instance.providerRef}` });
  notify({ orgId, title: "Database instance provisioned", body: `${name} (${providerName}) is being provisioned.`, dedupeKey: `rds:provision:${doc._id}`, severity: "info", recordId: doc._id });
  return { instance: instanceView(doc) };
}

async function loadInstance(orgId, instanceId) {
  let oid; try { oid = toObjectId(instanceId); } catch { return null; }
  const c = await getRdsCollections();
  return c.rdsInstances.findOne({ _id: oid, orgId: toObjectId(orgId) });
}

export async function listInstances({ orgId }) {
  const c = await getRdsCollections();
  const items = await c.rdsInstances.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).toArray();
  return { instances: items.map(instanceView) };
}

export async function getInstanceStatus({ orgId, instanceId }) {
  const inst = await loadInstance(orgId, instanceId); if (!inst) return fail("Instance not found.", 404);
  const mod = getProvider(inst.provider); if (!mod) return fail(`Provider "${inst.provider}" is no longer available.`, 500);
  const r = await mod.getInstance({ providerRef: inst.providerRef });
  if (!r.ok) return fail(r.error, 502);
  const c = await getRdsCollections();
  if (r.instance.status !== inst.status) await c.rdsInstances.updateOne({ _id: inst._id }, { $set: { status: r.instance.status, updatedAt: nowIso() } });
  return { instance: instanceView({ ...inst, status: r.instance.status }) };
}

async function lifecycleOp({ orgId, membership, actorEmail, instanceId, op, eventType, label }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can do that.", 403);
  const inst = await loadInstance(orgId, instanceId); if (!inst) return fail("Instance not found.", 404);
  const mod = getProvider(inst.provider); if (!mod) return fail(`Provider "${inst.provider}" is no longer available.`, 500);
  const r = await op(mod, inst);
  if (!r.ok) return fail(r.error, 502);
  await event({ orgId, type: eventType, recordId: inst._id, actorEmail, metadata: { instanceId: String(inst._id), providerRef: inst.providerRef } });
  notify({ orgId, title: `Database instance ${label}`, body: `${inst.name} was ${label} by ${actorEmail}.`, dedupeKey: `rds:${eventType}:${inst._id}`, severity: "info", recordId: inst._id });
  return { ok: true };
}

export const stopInstance = ({ orgId, membership, actorEmail, instanceId }) => lifecycleOp({ orgId, membership, actorEmail, instanceId, op: (mod, inst) => mod.stop({ providerRef: inst.providerRef }), eventType: "INSTANCE_STOPPED", label: "stopped" });
export const startInstance = ({ orgId, membership, actorEmail, instanceId }) => lifecycleOp({ orgId, membership, actorEmail, instanceId, op: (mod, inst) => mod.start({ providerRef: inst.providerRef }), eventType: "INSTANCE_STARTED", label: "started" });

export async function deprovisionInstance({ orgId, membership, actorEmail, instanceId, confirmName }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can do that.", 403);
  const inst = await loadInstance(orgId, instanceId); if (!inst) return fail("Instance not found.", 404);
  if (confirmName !== inst.name) return fail("Type the instance's exact name to confirm deletion.", 400);
  const mod = getProvider(inst.provider); if (!mod) return fail(`Provider "${inst.provider}" is no longer available.`, 500);
  const r = await mod.deprovision({ providerRef: inst.providerRef });
  if (!r.ok) return fail(r.error, 502);
  const c = await getRdsCollections();
  await c.rdsInstances.updateOne({ _id: inst._id }, { $set: { status: "deprovisioned", deletedAt: nowIso(), updatedAt: nowIso() } });
  await event({ orgId, type: "INSTANCE_DEPROVISIONED", recordId: inst._id, actorEmail, metadata: { instanceId: String(inst._id), providerRef: inst.providerRef } });
  notify({ orgId, title: "Database instance deleted", body: `${inst.name} was permanently deleted by ${actorEmail}.`, dedupeKey: `rds:deprovision:${inst._id}`, severity: "warning", recordId: inst._id });
  return { ok: true };
}

export async function listSnapshots({ orgId, instanceId }) {
  const inst = await loadInstance(orgId, instanceId); if (!inst) return fail("Instance not found.", 404);
  const mod = getProvider(inst.provider); if (!mod) return fail(`Provider "${inst.provider}" is no longer available.`, 500);
  if (!mod.capabilities().snapshot) return fail(`Snapshots are not supported by provider "${inst.provider}".`, 400);
  const r = await mod.listSnapshots({ providerRef: inst.providerRef });
  if (!r.ok) return fail(r.error, 502);
  return { snapshots: r.snapshots };
}

export async function restorePointInTime({ orgId, membership, actorEmail, instanceId, recoveryTimeUnix }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can do that.", 403);
  const inst = await loadInstance(orgId, instanceId); if (!inst) return fail("Instance not found.", 404);
  const mod = getProvider(inst.provider); if (!mod) return fail(`Provider "${inst.provider}" is no longer available.`, 500);
  if (!mod.capabilities().pitr) return fail(`Point-in-time restore is not supported by provider "${inst.provider}".`, 400);
  const r = await mod.restorePointInTime({ providerRef: inst.providerRef, recoveryTimeUnix });
  if (!r.ok) return fail(r.error, 502);
  await event({ orgId, type: "PITR_RESTORE_REQUESTED", recordId: inst._id, actorEmail, metadata: { instanceId: String(inst._id), recoveryTimeUnix } });
  notify({ orgId, title: "Point-in-time restore requested", body: `A restore was requested for ${inst.name} by ${actorEmail}. This is destructive -- verify before relying on it.`, dedupeKey: `rds:pitr:${inst._id}:${Date.now()}`, severity: "warning", recordId: inst._id });
  return { ok: true };
}

/** SQL Query Editor over a Workstream-A-hosted database (never legacyDataAccess's own gateway -- a different
 *  source). Any member with access may run a read-only query; only owner/admin may run a write. */
export async function runQuery({ orgId, membership, actorEmail, instanceId, sql, readOnly = true }) {
  if (!readOnly && !canManageOrg(membership)) return fail("Only the owner or an admin can run a write query.", 403);
  const inst = await loadInstance(orgId, instanceId); if (!inst) return fail("Instance not found.", 404);
  const mod = getProvider(inst.provider); if (!mod) return fail(`Provider "${inst.provider}" is no longer available.`, 500);
  if (!mod.capabilities().query) return fail(`Querying is not supported by provider "${inst.provider}".`, 400);
  const r = await mod.runQuery({ providerRef: inst.providerRef, sql, readOnly });
  if (!r.ok) return fail(r.error, 502);
  await event({ orgId, type: "QUERY_EXECUTED", recordId: inst._id, actorEmail, metadata: { instanceId: String(inst._id), readOnly, sqlPreview: String(sql).slice(0, 200) } });
  return { result: r.result };
}
