// src/lib/identity/runs.js
//
// A lifecycle RUN is the durable, inspectable record of one thing that happened to a person's access, whatever caused it: an
// external event (engine.js writes those itself), or a human/automation action recorded here (manual grant or revoke, temporary
// access expiry, access-review decision, incident restriction, reconciliation remediation). Runs are Evidence Graph subjects.

import { toObjectId } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { nowIso } from "./common.js";
import { audit, link, notifyManagers } from "./record.js";

export async function recordRun({ orgId, type, email, actor, state = "COMPLETED", plan = null, result = null, failure = null, provider = null, notify = null, evidence = [], reasonNote = null }) {
  const { identityRuns } = await getIdentityCollections();
  const run = { orgId: toObjectId(orgId), type, providerId: provider ? String(provider._id) : null, providerKind: provider?.kind || null, email: email || null, state, plan, result, failure, actor, origin: "internal", mode: "live", attempts: 1, createdAt: nowIso(), completedAt: state === "COMPLETED" ? nowIso() : null, reasonNote };
  run._id = (await identityRuns.insertOne(run)).insertedId;
  await audit({ orgId, runId: run._id, action: `IDENTITY_${type}`, actorEmail: actor, newState: state, metadata: { email, ...(reasonNote ? { reason: String(reasonNote).slice(0, 200) } : {}) } });
  for (const e of evidence) link({ orgId, runId: run._id, ...e });
  link({ orgId, runId: run._id, type: "PROVEN_BY", targetType: "IDENTITY_VERIFICATION", targetId: run._id, note: state === "COMPLETED" ? "verification passed" : `state: ${state}` });
  if (notify) await notifyManagers({ orgId, runId: run._id, title: notify.title, body: notify.body || "", severity: notify.severity || "info", dedupeKey: `identity:run:${run._id}:${state}` });
  return run;
}

export async function listRuns({ orgId, type = null, state = null, email = null, limit = 50, skip = 0 }) {
  const { identityRuns } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId) }; if (type) q.type = type; if (state) q.state = state; if (email) q.email = String(email).toLowerCase();
  const [rows, total] = await Promise.all([identityRuns.find(q).sort({ createdAt: -1 }).skip(Math.max(0, skip)).limit(Math.min(200, limit)).toArray(), identityRuns.countDocuments(q)]);
  return { total, runs: rows.map(runView) };
}
export async function getRun({ orgId, runId }) {
  const { identityRuns } = await getIdentityCollections();
  let id; try { id = toObjectId(runId); } catch { return null; }
  const r = await identityRuns.findOne({ _id: id, orgId: toObjectId(orgId) });
  return r || null;
}
export const runView = (r, full = false) => ({ runId: String(r._id), type: r.type, state: r.state, email: r.email, providerKind: r.providerKind || null, externalId: r.externalId || null, eventId: r.eventId || null, eventType: r.eventType || null, correlationId: r.correlationId || null, origin: r.origin, actor: r.actor, attempts: r.attempts || 1, createdAt: r.createdAt, completedAt: r.completedAt || null, nextRetryAt: r.nextRetryAt || null, failure: r.failure || null, ...(full ? { plan: r.plan, result: r.result } : { summary: { ops: (r.plan?.ops || []).length, verification: (r.result?.verification || []).filter((v) => !v.ok).length ? "FAILED" : "OK" } }) });
