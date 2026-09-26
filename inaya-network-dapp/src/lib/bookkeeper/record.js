// src/lib/bookkeeper/record.js
//
// AI Bookkeeper SOW sections 29, 30, 31, 37: how a bookkeeping action is recorded. Not a second audit chain and not a second Evidence Graph:
//   audit()   -> the organization's existing hash-chained audit trail (logOrgActivity), recordType BOOKKEEPING
//   link()    -> the existing Evidence Graph: a bank transaction or captured document is a subject; each step is a typed relationship
//   notify()  -> the existing notification system, to members who may see finance data (owners, admins, finance-role holders) only
// No secret, credential, or full document payload is ever passed here: identifiers, confidences and outcomes only.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { createNotification } from "../notifications.js";
import { EVENT_TYPES, RULES_VERSION } from "./common.js";

const SYNTH = { role: "owner" };

export async function audit({ orgId, recordId = null, action, actorEmail = "ai-bookkeeper", previousState = null, newState = null, metadata = {} }) {
  try {
    const ev = await logOrgActivity({ orgId, recordType: "BOOKKEEPING", recordId: recordId || orgId, actorEmail, action, previousState, newState, metadata: { rulesVersion: RULES_VERSION, ...metadata } });
    return ev.auditChain || null;
  } catch (err) { console.error("bookkeeper audit failed (non-fatal):", err.message); return null; }
}

let chain = Promise.resolve();
export const flushEvidence = () => chain;

async function ensureSubject(orgId, subjectType, subjectId) {
  const { businessEvents } = await getOrgCollections();
  let ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType, subjectId: toObjectId(subjectId), deletedAt: null });
  if (!ev) {
    const r = await createBusinessEvent({ orgId, subjectType, subjectId: String(subjectId), membership: SYNTH, actorEmail: "system", relationships: [] });
    if (r.error) throw new Error(r.error);
    ev = r.event;
  }
  return ev;
}

/** Serialized, non-blocking Evidence Graph write. subjectType: BOOKKEEPING_TRANSACTION | BOOKKEEPING_DOCUMENT. */
export function link({ orgId, subjectType, subjectId, type, targetType, targetId, note }) {
  chain = chain.then(async () => {
    try {
      const ev = await ensureSubject(orgId, subjectType, subjectId);
      const r = await addBusinessEventRelationship({ orgId, eventId: String(ev._id), membership: SYNTH, actorEmail: "system", type, targetType, targetId: String(targetId), note: String(note || "").slice(0, 200) });
      if (r?.error && !/already/i.test(r.error)) console.error("bookkeeper evidence link skipped:", r.error);
    } catch (err) { console.error("bookkeeper evidence link failed (non-fatal):", err.message); }
  });
  return chain;
}

/** Records one bookkeeping event type (SOW section 30) in the audit trail. */
export async function event({ orgId, type, recordId, actorEmail, previousState = null, newState = null, metadata = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown bookkeeping event ${type}`);
  return audit({ orgId, recordId, action: type, actorEmail, previousState, newState, metadata });
}

/** Members allowed to see finance data: owners, admins, and holders of a finance role. */
export async function financeAudience(orgId) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.find({ orgId: toObjectId(orgId), status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { financeRole: { $in: ["manager", "staff"] } }] }).project({ email: 1 }).toArray();
}

export async function notify({ orgId, title, body, dedupeKey, severity = "info", recordId = null }) {
  try {
    for (const a of await financeAudience(orgId)) await createNotification({ scope: "org", orgId, targetEmail: a.email, category: "business", severity, type: "bookkeeper", title, body: String(body || "").slice(0, 500), sourceModule: "bookkeeper", sourceId: recordId ? String(recordId) : null, actionUrl: "/business?view=bookkeeper", metadata: {}, dedupeKey: `${dedupeKey}:${a.email}` });
  } catch (err) { console.error("bookkeeper notify failed (non-fatal):", err.message); }
}
