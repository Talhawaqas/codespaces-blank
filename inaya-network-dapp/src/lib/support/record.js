// src/lib/support/record.js
//
// SOW §5.5, §5.6, §31: how a support event is recorded. NOT a second audit chain and NOT a second evidence
// store:
//   1. audit()   -> the organization's existing hash-chained audit trail (logOrgActivity);
//   2. emit()    -> a row in `supportEvents` (the feed used by the API, analytics and the customer-visible
//                   timeline), the outbound webhooks, and the Automations engine (as a workflow event);
//   3. link()    -> the existing Evidence Graph: the ticket is a subject (SUPPORT_TICKET) and important steps
//                   (AI triage, assignment, linked invoice, KB source, escalation, resolution) are typed
//                   relationships. Graph writes never block or fail a customer-facing operation.
// Internal notes and evidence are never exposed to customers through any of these.

import { toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { getSupportCollections } from "./db.js";
import { nowIso, SUPPORT_EVENTS } from "./common.js";
import { enqueueDeliveries } from "./webhooks.js";

const SYNTH = { role: "owner" };

/** Writes one entry to the org audit chain. Returns the chain reference or null; never throws. */
export async function audit({ orgId, ticketId = null, action, actorEmail = "system", previousState = null, newState = null, metadata = {} }) {
  try {
    const ev = await logOrgActivity({ orgId, recordType: ticketId ? "SUPPORT_TICKET" : "SUPPORT", recordId: ticketId || orgId, actorEmail, action, previousState, newState, metadata });
    return ev.auditChain || null;
  } catch (err) { console.error("support audit failed (non-fatal):", err.message); return null; }
}

export function ticketSummary(t) {
  return { id: String(t._id), number: t.number, subject: t.subject, status: t.status, priority: t.priority, type: t.type, category: t.category, channel: t.channel, queueId: t.queueId ? String(t.queueId) : null, assigneeEmail: t.assigneeEmail || null, requesterEmail: t.requester?.email || null, createdAt: t.createdAt, slaState: t.slaView?.state || t.slaState || null };
}

let eventSeq = 0;
/** Records the event in the feed, queues webhook deliveries and raises the workflow event. Never throws. */
export async function emit({ orgId, type, ticket = null, data = {}, actor = null, customerVisible = false }) {
  try {
    if (!SUPPORT_EVENTS.includes(type)) return null;
    const { supportEvents } = await getSupportCollections();
    const doc = { orgId: toObjectId(orgId), type, ticketId: ticket?._id ? ticket._id : null, data, actor, customerVisible, createdAt: nowIso(), seq: ++eventSeq };
    const r = await supportEvents.insertOne(doc);
    const payload = { id: String(r.insertedId), type, createdAt: doc.createdAt, organizationId: String(orgId), ticket: ticket ? ticketSummary(ticket) : null, data };
    await enqueueDeliveries({ orgId, event: payload }).catch((e) => console.error("support webhook enqueue failed (non-fatal):", e.message));
    import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId, type: "event", key: `support.${type}`, eventId: String(r.insertedId), payload: { ticket: payload.ticket, data } })).catch(() => {});
    return { ...doc, _id: r.insertedId };
  } catch (err) { console.error("support emit failed (non-fatal):", err.message); return null; }
}

// ---------------------------------------------------------------- Evidence Graph
let chain = Promise.resolve();
/** Tests (and shutdown paths) await this to be sure queued graph writes have landed. */
export const flushEvidence = () => chain;

async function ensureTicketEvent(orgId, ticketId) {
  const { db } = await getSupportCollections();
  let ev = await db.collection("business_events").findOne({ orgId: toObjectId(orgId), subjectType: "SUPPORT_TICKET", subjectId: toObjectId(ticketId), deletedAt: null });
  if (!ev) {
    const r = await createBusinessEvent({ orgId, subjectType: "SUPPORT_TICKET", subjectId: String(ticketId), membership: SYNTH, actorEmail: "system", relationships: [] });
    if (r.error) throw new Error(r.error);
    ev = r.event;
  }
  return ev;
}

/**
 * Adds a typed relationship from the ticket to something that explains it. type is one of the Evidence
 * Graph's own relationship types (RELATES_TO, SOURCED_FROM, REQUIRES, ANALYZED_BY, CHECKED_BY, APPROVED_BY,
 * EXECUTED_AS, PROVEN_BY, DERIVED_FROM, REFERENCES). Serialized, non-blocking.
 */
export function link({ orgId, ticketId, type, targetType, targetId, note }) {
  chain = chain.then(async () => {
    try {
      const ev = await ensureTicketEvent(orgId, ticketId);
      await addBusinessEventRelationship({ orgId, eventId: String(ev._id), membership: SYNTH, actorEmail: "system", type, targetType, targetId: String(targetId), note });
    } catch (err) { console.error("support evidence link failed (non-fatal):", err.message); }
  });
  return chain;
}

/** Analytics-only event (no webhook, no workflow): what people searched, viewed and rated. Never throws. */
export async function track({ orgId, type, actor = null, data = {}, ticket = null }) {
  try {
    const { supportEvents } = await getSupportCollections();
    await supportEvents.insertOne({ orgId: toObjectId(orgId), type, ticketId: ticket?._id || null, data, actor, customerVisible: false, analytics: true, createdAt: nowIso() });
  } catch (err) { console.error("support track failed (non-fatal):", err.message); }
}
