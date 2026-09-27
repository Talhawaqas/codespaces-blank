// src/lib/docIntelligence/record.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C. How an analyzer run is recorded --
// same shape as bookkeeper/record.js, deliberately NOT a second audit chain and NOT a second Evidence Graph:
//   audit()   -> the organization's existing hash-chained audit trail (logOrgActivity), recordType DOC_INTELLIGENCE
//   link()    -> the existing Evidence Graph: an analysis result is a subject; each step is a typed relationship
//   notify()  -> the existing notification system, org owners/admins only (no finance-specific audience here)

import { toObjectId, getOrgCollections, canManageOrg } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { createNotification } from "../notifications.js";

const SYNTH = { role: "owner" };
export const EVENT_TYPES = [
  "ANALYZER_CREATED", "ANALYZER_STATUS_CHANGED",
  "DOCUMENT_ANALYZED", "HUMAN_REVIEW_STARTED", "REVIEW_CORRECTION_APPLIED", "REVIEW_APPROVED", "REVIEW_REJECTED",
  "EVALUATION_RUN",
];

export async function audit({ orgId, recordId = null, action, actorEmail = "doc-intelligence", previousState = null, newState = null, metadata = {} }) {
  try {
    const ev = await logOrgActivity({ orgId, recordType: "DOC_INTELLIGENCE", recordId: recordId || orgId, actorEmail, action, previousState, newState, metadata });
    return ev.auditChain || null;
  } catch (err) { console.error("doc-intelligence audit failed (non-fatal):", err.message); return null; }
}

let chain = Promise.resolve();
export const flushEvidence = () => chain;

async function ensureSubject(orgId, subjectId) {
  const { businessEvents } = await getOrgCollections();
  let ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "DOC_INTELLIGENCE_RESULT", subjectId: toObjectId(subjectId), deletedAt: null });
  if (!ev) {
    const r = await createBusinessEvent({ orgId, subjectType: "DOC_INTELLIGENCE_RESULT", subjectId: String(subjectId), membership: SYNTH, actorEmail: "system", relationships: [] });
    if (r.error) throw new Error(r.error);
    ev = r.event;
  }
  return ev;
}

/** Serialized, non-blocking Evidence Graph write, same discipline as bookkeeper's link(). */
export function link({ orgId, subjectId, type, targetType, targetId, note }) {
  chain = chain.then(async () => {
    try {
      const ev = await ensureSubject(orgId, subjectId);
      const r = await addBusinessEventRelationship({ orgId, eventId: String(ev._id), membership: SYNTH, actorEmail: "system", type, targetType, targetId: String(targetId), note: String(note || "").slice(0, 200) });
      if (r?.error && !/already/i.test(r.error)) console.error("doc-intelligence evidence link skipped:", r.error);
    } catch (err) { console.error("doc-intelligence evidence link failed (non-fatal):", err.message); }
  });
  return chain;
}

export async function event({ orgId, type, recordId, actorEmail, previousState = null, newState = null, metadata = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown doc-intelligence event ${type}`);
  return audit({ orgId, recordId, action: type, actorEmail, previousState, newState, metadata });
}

/** Owners/admins only -- an analyzer result is an operational/governance artifact, not department-scoped finance data. */
export async function opsAudience(orgId) {
  const { orgMembers } = await getOrgCollections();
  const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, role: 1 }).toArray();
  return members.filter((m) => canManageOrg(m));
}

export async function notify({ orgId, title, body, dedupeKey, severity = "info", recordId = null }) {
  try {
    for (const a of await opsAudience(orgId)) await createNotification({ scope: "org", orgId, targetEmail: a.email, category: "business", severity, type: "doc-intelligence", title, body: String(body || "").slice(0, 500), sourceModule: "docIntelligence", sourceId: recordId ? String(recordId) : null, actionUrl: "/business?view=doc-intelligence", metadata: {}, dedupeKey: `${dedupeKey}:${a.email}` });
  } catch (err) { console.error("doc-intelligence notify failed (non-fatal):", err.message); }
}
