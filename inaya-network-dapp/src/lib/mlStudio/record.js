// src/lib/mlStudio/record.js -- audit/link/notify, same shape as every other feature's record.js in this
// codebase. A registered model VERSION is the Evidence Graph subject; catalog entries, data-quality runs and
// evaluation runs are recorded as typed relationships on it (or, for a catalog entry with no model yet, as a
// plain audit-trail entry -- not every governance action needs its own subject).

import { toObjectId, getOrgCollections, canManageOrg } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { createNotification } from "../notifications.js";

const SYNTH = { role: "owner" };
export const EVENT_TYPES = [
  "CATALOG_ENTRY_REGISTERED", "DATA_QUALITY_RULE_CREATED", "DATA_QUALITY_RUN",
  "MODEL_REGISTERED", "MODEL_STATUS_CHANGED", "EVALUATION_RUN", "LINEAGE_RECORDED",
  "CODE_EXECUTED",
];

export async function audit({ orgId, recordId = null, action, actorEmail = "ml-studio", previousState = null, newState = null, metadata = {} }) {
  try { const ev = await logOrgActivity({ orgId, recordType: "ML_STUDIO", recordId: recordId || orgId, actorEmail, action, previousState, newState, metadata }); return ev.auditChain || null; }
  catch (err) { console.error("ml-studio audit failed (non-fatal):", err.message); return null; }
}

let chain = Promise.resolve();
export const flushEvidence = () => chain;

async function ensureSubject(orgId, subjectId) {
  const { businessEvents } = await getOrgCollections();
  let ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "ML_STUDIO_MODEL", subjectId: toObjectId(subjectId), deletedAt: null });
  if (!ev) { const r = await createBusinessEvent({ orgId, subjectType: "ML_STUDIO_MODEL", subjectId: String(subjectId), membership: SYNTH, actorEmail: "system", relationships: [] }); if (r.error) throw new Error(r.error); ev = r.event; }
  return ev;
}

export function link({ orgId, subjectId, type, targetType, targetId, note }) {
  chain = chain.then(async () => {
    try { const ev = await ensureSubject(orgId, subjectId); const r = await addBusinessEventRelationship({ orgId, eventId: String(ev._id), membership: SYNTH, actorEmail: "system", type, targetType, targetId: String(targetId), note: String(note || "").slice(0, 200) }); if (r?.error && !/already/i.test(r.error)) console.error("ml-studio evidence link skipped:", r.error); }
    catch (err) { console.error("ml-studio evidence link failed (non-fatal):", err.message); }
  });
  return chain;
}

export async function event({ orgId, type, recordId, actorEmail, previousState = null, newState = null, metadata = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown ml-studio event ${type}`);
  return audit({ orgId, recordId, action: type, actorEmail, previousState, newState, metadata });
}

export async function opsAudience(orgId) {
  const { orgMembers } = await getOrgCollections();
  const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, role: 1 }).toArray();
  return members.filter((m) => canManageOrg(m));
}

export async function notify({ orgId, title, body, dedupeKey, severity = "info", recordId = null }) {
  try { for (const a of await opsAudience(orgId)) await createNotification({ scope: "org", orgId, targetEmail: a.email, category: "business", severity, type: "ml-studio", title, body: String(body || "").slice(0, 500), sourceModule: "mlStudio", sourceId: recordId ? String(recordId) : null, actionUrl: "/business?view=mlStudio", metadata: {}, dedupeKey: `${dedupeKey}:${a.email}` }); }
  catch (err) { console.error("ml-studio notify failed (non-fatal):", err.message); }
}
