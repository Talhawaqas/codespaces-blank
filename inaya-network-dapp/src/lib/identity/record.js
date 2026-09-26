// src/lib/identity/record.js
//
// SOW §39, §40, §46: how an identity action is recorded. Not a second audit chain and not a second Evidence Graph:
//   audit()   -> the organization's existing hash-chained audit trail (logOrgActivity), recordType IDENTITY_LIFECYCLE;
//   link()    -> the existing Evidence Graph: a lifecycle run is a subject (IDENTITY_LIFECYCLE) and each step is a typed
//                relationship (source event, identity mapping, policy, decision, permission change, credential
//                revocation, verification, notification). Graph writes never block or fail the operation;
//   notify()  -> the existing notification system (deduplicated), to the organization's owners and admins.
// Secrets never reach any of these: callers pass identifiers and outcomes only.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { createNotification } from "../notifications.js";
import { nowIso } from "./common.js";

const SYNTH = { role: "owner" };

/** Writes to the org audit chain. `runId` (or the org id) is the record id. Never throws. Returns the chain reference or null. */
export async function audit({ orgId, runId = null, action, actorEmail = "identity-integration", previousState = null, newState = null, metadata = {} }) {
  try {
    const ev = await logOrgActivity({ orgId, recordType: "IDENTITY_LIFECYCLE", recordId: runId || orgId, actorEmail, action, previousState, newState, metadata });
    return ev.auditChain || null;
  } catch (err) { console.error("identity audit failed (non-fatal):", err.message); return null; }
}

let chain = Promise.resolve();
/** Tests (and shutdown paths) await this so queued Evidence Graph writes have landed. */
export const flushEvidence = () => chain;

async function ensureSubject(orgId, runId) {
  const { businessEvents } = await getOrgCollections();
  let ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "IDENTITY_LIFECYCLE", subjectId: toObjectId(runId), deletedAt: null });
  if (!ev) {
    const r = await createBusinessEvent({ orgId, subjectType: "IDENTITY_LIFECYCLE", subjectId: String(runId), membership: SYNTH, actorEmail: "system", relationships: [] });
    if (r.error) throw new Error(r.error);
    ev = r.event;
  }
  return ev;
}

/** type = one of the Evidence Graph's own relationship types (SOURCED_FROM, CHECKED_BY, APPROVED_BY, EXECUTED_AS, PROVEN_BY, ...). Serialized, non-blocking. */
export function link({ orgId, runId, type, targetType, targetId, note }) {
  chain = chain.then(async () => {
    try {
      const ev = await ensureSubject(orgId, runId);
      await addBusinessEventRelationship({ orgId, eventId: String(ev._id), membership: SYNTH, actorEmail: "system", type, targetType, targetId: String(targetId), note });
    } catch (err) { console.error("identity evidence link failed (non-fatal):", err.message); }
  });
  return chain;
}

/** Notifies owners and admins once per dedupeKey. `severity` info|warning|critical. Never throws. */
export async function notifyManagers({ orgId, title, body, dedupeKey, severity = "info", runId = null }) {
  try {
    const { orgMembers } = await getOrgCollections();
    const admins = await orgMembers.find({ orgId: toObjectId(orgId), status: "active", role: { $in: ["owner", "admin"] } }).project({ email: 1 }).toArray();
    for (const a of admins) await createNotification({ scope: "org", orgId, targetEmail: a.email, category: "security", severity, type: "identity", title, body: String(body || "").slice(0, 500), sourceModule: "identity", sourceId: runId ? String(runId) : null, actionUrl: "/business?view=identity", metadata: { runId: runId ? String(runId) : null }, dedupeKey: `${dedupeKey}:${a.email}` });
    return { notified: admins.length };
  } catch (err) { console.error("identity notify failed (non-fatal):", err.message); return { notified: 0 }; }
}

export const stamp = nowIso;
