// src/lib/rds/record.js -- audit/link/notify, same shape as bookkeeper/record.js and docIntelligence/record.js.
// A database instance is an Evidence Graph subject (RDS_INSTANCE) so provisioning, start/stop, snapshots and
// restores are never a second, disconnected log -- they show up in the same timeline/passport views.

import { toObjectId, getOrgCollections, canManageOrg } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { createNotification } from "../notifications.js";

const SYNTH = { role: "owner" };
export const EVENT_TYPES = ["INSTANCE_PROVISIONED", "INSTANCE_STARTED", "INSTANCE_STOPPED", "INSTANCE_DEPROVISIONED", "SNAPSHOT_LISTED", "PITR_RESTORE_REQUESTED", "QUERY_EXECUTED"];

export async function audit({ orgId, recordId = null, action, actorEmail = "rds-control-plane", previousState = null, newState = null, metadata = {} }) {
  try { const ev = await logOrgActivity({ orgId, recordType: "RDS", recordId: recordId || orgId, actorEmail, action, previousState, newState, metadata }); return ev.auditChain || null; }
  catch (err) { console.error("rds audit failed (non-fatal):", err.message); return null; }
}

let chain = Promise.resolve();
export const flushEvidence = () => chain;

async function ensureSubject(orgId, subjectId) {
  const { businessEvents } = await getOrgCollections();
  let ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "RDS_INSTANCE", subjectId: toObjectId(subjectId), deletedAt: null });
  if (!ev) { const r = await createBusinessEvent({ orgId, subjectType: "RDS_INSTANCE", subjectId: String(subjectId), membership: SYNTH, actorEmail: "system", relationships: [] }); if (r.error) throw new Error(r.error); ev = r.event; }
  return ev;
}

export function link({ orgId, subjectId, type, targetType, targetId, note }) {
  chain = chain.then(async () => {
    try { const ev = await ensureSubject(orgId, subjectId); const r = await addBusinessEventRelationship({ orgId, eventId: String(ev._id), membership: SYNTH, actorEmail: "system", type, targetType, targetId: String(targetId), note: String(note || "").slice(0, 200) }); if (r?.error && !/already/i.test(r.error)) console.error("rds evidence link skipped:", r.error); }
    catch (err) { console.error("rds evidence link failed (non-fatal):", err.message); }
  });
  return chain;
}

export async function event({ orgId, type, recordId, actorEmail, previousState = null, newState = null, metadata = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown rds event ${type}`);
  return audit({ orgId, recordId, action: type, actorEmail, previousState, newState, metadata });
}

export async function opsAudience(orgId) {
  const { orgMembers } = await getOrgCollections();
  const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, role: 1 }).toArray();
  return members.filter((m) => canManageOrg(m));
}

export async function notify({ orgId, title, body, dedupeKey, severity = "info", recordId = null }) {
  try { for (const a of await opsAudience(orgId)) await createNotification({ scope: "org", orgId, targetEmail: a.email, category: "business", severity, type: "rds", title, body: String(body || "").slice(0, 500), sourceModule: "rds", sourceId: recordId ? String(recordId) : null, actionUrl: "/business?view=rds", metadata: {}, dedupeKey: `${dedupeKey}:${a.email}` }); }
  catch (err) { console.error("rds notify failed (non-fatal):", err.message); }
}
