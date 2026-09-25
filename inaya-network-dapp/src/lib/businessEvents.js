// src/lib/businessEvents.js
//
// Evidence Graph & Trusted Business Event Layer SOW — the Business Event
// core. Per the SOW's explicit non-goals, this is a CONNECTING layer, not
// a rewrite: a BusinessEvent never copies an invoice/PO/PR/AI-action
// record, it references one by {subjectType, subjectId} and stores typed
// relationships to whatever else the event touches (a linked PO, a linked
// AI action request, etc.). Every mutation goes through logOrgActivity()
// (org-activity-log.js), which already both writes the human-readable
// org_activity feed AND appends to the real cryptographic audit chain
// (auditChain.js) — so a BusinessEvent's "proof" is never a second hash
// chain, it's a query into the one that already exists.
//
// PERMISSION MODEL: a BusinessEvent inherits its subject's own visibility
// rule rather than inventing a new one. Invoices/POs/PRs are department-
// scoped (canAccessDepartment), so a BusinessEvent about one of those
// copies that record's departmentId at creation time and is checked the
// same way. AI action requests have no departmentId of their own (see
// ai-action-requests.js) — for those, resolve the underlying target
// record's department where the EXECUTORS map makes that possible, else
// fall back to org-manager-only visibility (departmentId: null), which is
// at least as strict as AI action requests' own effective access model.

import { getOrgCollections, canAccessDepartment, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity, listOrgActivityForRecord } from "./org-activity-log.js";
import { classifyRisk as classifyAiActionRisk } from "./ai-action-requests.js";
import { createNotification } from "./notifications.js";

// Same "notify owners/admins, wrap in try/catch, never break the real
// mutation" discipline as ai-action-requests.js's own
// notifyOrgManagersOfProposal — only for HIGH-risk events, so this
// doesn't become notification noise for routine ones.
async function notifyManagersOfHighRiskEvent({ orgId, event }) {
  try {
    const { orgMembers } = await getOrgCollections();
    const managers = await orgMembers.find({ orgId: toObjectId(orgId), role: { $in: ["owner", "admin"] }, status: "active" }).toArray();
    await Promise.all(
      managers
        .filter((m) => m.email !== event.createdByEmail)
        .map((m) =>
          createNotification({
            scope: "org", orgId, targetEmail: m.email, category: "businessEvent", severity: "warning",
            type: "business_event_high_risk", title: `High-risk business event opened: ${event.eventType}`,
            body: event.subjectSummary?.label ? `Subject: ${event.subjectSummary.label}` : `Subject: ${event.subjectType}`,
            sourceModule: "business-events", sourceId: event._id, actionUrl: "/business?view=evidence",
            dedupeKey: `${orgId}:business_event_high_risk:${event._id}:${m.email}`,
          })
        )
    );
  } catch (err) {
    console.error("notifyManagersOfHighRiskEvent failed (non-fatal):", err.message);
  }
}

export const BUSINESS_EVENT_STATUSES = [
  "OPEN",       // created, evidence/relationships may still be added
  "DECIDED",    // a decision (approval/rejection or AI recommendation) has been recorded
  "EXECUTED",   // the underlying subject reached a terminal executed/completed state
  "CLOSED",     // event explicitly closed (subject rejected/cancelled, or manually closed)
];

// The SOW's event-type registry (§9) is intentionally scoped down here to
// the subject types Inaya actually has real workflows for today — adding
// a new one later is one line, not an architecture change.
export const EVENT_TYPES = {
  INVOICE: "INVOICE_PROCESSING",
  PURCHASE_ORDER: "PURCHASE_ORDER",
  PURCHASE_REQUEST: "PURCHASE_REQUEST",
  AI_ACTION_REQUEST: "AI_ACTION",
  // AI Security Workflow 2026 SOW -- a non-ALLOW AI security decision
  // (BLOCK/REDACT/WARN/REQUIRE_APPROVAL) becomes a real Business Event,
  // not a second audit trail (see aiSecurity/events.js).
  AI_SECURITY_CHECK: "AI_SECURITY_CHECK",
};

// Subject-type -> collection/department-resolution table. Kept in one
// place so createBusinessEvent() and every read path resolve a subject
// identically — no second, divergent lookup.
const SUBJECT_RESOLVERS = {
  INVOICE: { collectionKey: "invoices", hasDepartment: true },
  PURCHASE_ORDER: { collectionKey: "purchaseOrders", hasDepartment: true },
  PURCHASE_REQUEST: { collectionKey: "purchaseRequests", hasDepartment: true },
  AI_ACTION_REQUEST: { collectionKey: "aiActionRequests", hasDepartment: false },
  // Same "no department of its own" shape as AI_ACTION_REQUEST -- an AI
  // security check isn't scoped to one department, so it falls back to
  // org-manager-only visibility (departmentId: null), same as above.
  AI_SECURITY_CHECK: { collectionKey: "aiSecurityChecks", hasDepartment: false },
};

// Typed relationship vocabulary (SOW §8). Extensible: this is a plain
// array, not an enum baked into a schema validator, so a new edge type
// is additive.
export const RELATIONSHIP_TYPES = [
  "RELATES_TO", "SOURCED_FROM", "REQUIRES", "ANALYZED_BY", "CHECKED_BY",
  "APPROVED_BY", "EXECUTED_AS", "PROVEN_BY", "DERIVED_FROM", "REFERENCES",
];

function amountOf(subject) {
  // "total" is the real field on invoices (see finance/invoices/route.js's
  // computeTotal()); POs/PRs have no stored total (a PO's is derived from
  // its items array, per purchase-order-workflow.js's own header comment)
  // and estimatedCost is the closest real field on a PurchaseRequest.
  const raw = subject?.total ?? subject?.estimatedCost ?? subject?.totalAmount ?? subject?.amount ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Reuses ai-action-requests.js's own risk table for AI-action subjects
 *  (same "HIGH" bucket as INVOICE/PURCHASE_ORDER there); for the other
 *  three subject types, a request/order/invoice is itself already HIGH
 *  risk per that same table's per-domain defaults, so mirroring rather
 *  than reinventing a second scale keeps the two systems' language
 *  consistent for a user who sees both. */
function classifyEventRisk(subjectType, subject) {
  if (subjectType === "AI_ACTION_REQUEST") return subject.riskLevel || "MEDIUM";
  // aiSecurityChecks.severity is already one of the shared SEVERITIES
  // (policyTypes.js) -- CRITICAL/HIGH map onto this graph's HIGH bucket
  // since BusinessEvent itself has no CRITICAL tier.
  if (subjectType === "AI_SECURITY_CHECK") {
    return subject.severity === "CRITICAL" || subject.severity === "HIGH" ? "HIGH" : subject.severity === "MEDIUM" ? "MEDIUM" : "LOW";
  }
  return classifyAiActionRisk(subjectType, undefined);
}

async function resolveSubject({ orgId, subjectType, subjectId }) {
  const resolver = SUBJECT_RESOLVERS[subjectType];
  if (!resolver) return { error: `Unsupported subject type "${subjectType}".`, status: 400 };
  const collections = await getOrgCollections();
  const collection = collections[resolver.collectionKey];
  const subject = await collection.findOne({ _id: toObjectId(subjectId), orgId: toObjectId(orgId), deletedAt: { $ne: true } });
  if (!subject) return { error: `${subjectType} not found.`, status: 404 };
  return { subject, resolver };
}

/** AI action requests carry no departmentId of their own; resolve the
 *  department of whatever real record they'd eventually act on, when
 *  that record itself is department-scoped. Falls back to null (org-
 *  manager-only visibility) rather than guessing. */
async function resolveAiActionDepartment({ orgId, aiRequest }) {
  const map = { TASK: "tasks", EXPENSE: "expenses", DOCUMENT: "orgDocuments", EMPLOYEE: "employees", INVOICE: "invoices", LEAVE_REQUEST: "leaveRequests", PURCHASE_ORDER: "purchaseOrders", PURCHASE_REQUEST: "purchaseRequests", DEAL: "crmDeals" };
  const collectionKey = map[aiRequest.targetRecordType];
  if (!collectionKey || !aiRequest.targetRecordId) return null;
  try {
    const collections = await getOrgCollections();
    const target = await collections[collectionKey].findOne({ _id: toObjectId(aiRequest.targetRecordId), orgId: toObjectId(orgId) });
    return target?.departmentId || null;
  } catch {
    return null;
  }
}

/** Creates a new Business Event referencing an existing subject record.
 *  Never copies the subject's fields beyond a small display summary
 *  (SOW §6 "reference existing records rather than copy entire business
 *  objects") — the summary exists only so list/timeline views don't need
 *  an extra lookup for the common case, and is never treated as the
 *  source of truth (permission-aware reads always re-resolve the live
 *  subject). */
export async function createBusinessEvent({ orgId, subjectType, subjectId, membership, actorEmail, relationships = [] }) {
  const resolved = await resolveSubject({ orgId, subjectType, subjectId });
  if (resolved.error) return resolved;
  const { subject, resolver } = resolved;

  let departmentId = null;
  if (resolver.hasDepartment) {
    departmentId = subject.departmentId;
    if (!canAccessDepartment(membership, departmentId)) return { error: "You don't have permission to do that.", status: 403 };
  } else {
    departmentId = await resolveAiActionDepartment({ orgId, aiRequest: subject });
    if (departmentId ? !canAccessDepartment(membership, departmentId) : !canManageOrg(membership)) {
      return { error: "You don't have permission to do that.", status: 403 };
    }
  }

  const cleanRelationships = [];
  for (const rel of Array.isArray(relationships) ? relationships : []) {
    if (!RELATIONSHIP_TYPES.includes(rel?.type)) continue;
    if (!rel?.targetType || !rel?.targetId) continue;
    cleanRelationships.push({ type: rel.type, targetType: String(rel.targetType), targetId: toObjectId(rel.targetId), note: rel.note ? String(rel.note).slice(0, 500) : null });
  }

  const { businessEvents } = await getOrgCollections();
  const now = new Date().toISOString();
  const subjectSummary = summarizeSubject(subjectType, subject);
  const doc = {
    orgId: toObjectId(orgId),
    departmentId: departmentId ? toObjectId(departmentId) : null,
    eventType: EVENT_TYPES[subjectType] || "OTHER",
    subjectType,
    subjectId: toObjectId(subjectId),
    subjectSummary,
    // Flat copy of subjectSummary.label so orgSearch.js's matchText() (which
    // only checks top-level fields, not nested paths) can find this event —
    // see orgSearch.js's SEARCHABLE_FIELDS. Not a second source of truth,
    // just a denormalized search key kept in sync at creation time.
    subjectLabel: subjectSummary.label || null,
    status: "OPEN",
    riskLevel: classifyEventRisk(subjectType, subject),
    relationships: cleanRelationships,
    createdByEmail: actorEmail,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
  };
  const { insertedId } = await businessEvents.insertOne(doc);

  await logOrgActivity({
    orgId, recordType: "BUSINESS_EVENT", recordId: insertedId, actorEmail,
    action: "EVENT_CREATED", previousState: null, newState: "OPEN",
    metadata: { subjectType, subjectId: String(subjectId), riskLevel: doc.riskLevel },
  });

  const event = { ...doc, _id: insertedId };
  if (event.riskLevel === "HIGH") await notifyManagersOfHighRiskEvent({ orgId, event });

  return { event };
}

function summarizeSubject(subjectType, subject) {
  const base = { status: subject.status || null, amount: amountOf(subject) };
  if (subjectType === "INVOICE") return { ...base, label: subject.invoiceNumber || null };
  if (subjectType === "PURCHASE_ORDER" || subjectType === "PURCHASE_REQUEST") return { ...base, label: subject.title || subject.description || null };
  if (subjectType === "AI_ACTION_REQUEST") return { ...base, label: subject.proposedAction || null, status: subject.status };
  if (subjectType === "AI_SECURITY_CHECK") return { ...base, label: `${subject.decision}: ${subject.category}`, status: subject.decision };
  return base;
}

function canViewEvent(membership, event) {
  if (event.departmentId) return canAccessDepartment(membership, event.departmentId);
  return canManageOrg(membership);
}

export async function getBusinessEvent({ orgId, eventId, membership }) {
  const { businessEvents } = await getOrgCollections();
  const event = await businessEvents.findOne({ _id: toObjectId(eventId), orgId: toObjectId(orgId), deletedAt: null });
  if (!event) return { error: "Business event not found.", status: 404 };
  if (!canViewEvent(membership, event)) return { error: "You don't have permission to view this event.", status: 403 };
  return { event };
}

export async function listBusinessEvents({ orgId, membership, status, subjectType }) {
  const { businessEvents } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId), deletedAt: null };
  if (status && BUSINESS_EVENT_STATUSES.includes(status)) filter.status = status;
  if (subjectType && SUBJECT_RESOLVERS[subjectType]) filter.subjectType = subjectType;
  const all = await businessEvents.find(filter).sort({ createdAt: -1 }).toArray();
  return all.filter((e) => canViewEvent(membership, e));
}

/** Appends a typed relationship (new evidence link) to an existing event.
 *  Additive only — relationships are never removed, matching the SOW's
 *  "immutable scenario/evidence" discipline elsewhere in this session's
 *  work; a wrong link is superseded by adding a corrected one, not by
 *  editing history. */
export async function addBusinessEventRelationship({ orgId, eventId, membership, actorEmail, type, targetType, targetId, note }) {
  if (!RELATIONSHIP_TYPES.includes(type)) return { error: `Unknown relationship type "${type}".`, status: 400 };
  const got = await getBusinessEvent({ orgId, eventId, membership });
  if (got.error) return got;

  const relationship = { type, targetType: String(targetType), targetId: toObjectId(targetId), note: note ? String(note).slice(0, 500) : null, addedAt: new Date().toISOString(), addedByEmail: actorEmail };
  const { businessEvents } = await getOrgCollections();
  await businessEvents.updateOne({ _id: got.event._id }, { $push: { relationships: relationship }, $set: { updatedAt: relationship.addedAt } });

  await logOrgActivity({
    orgId, recordType: "BUSINESS_EVENT", recordId: got.event._id, actorEmail,
    action: "EVIDENCE_ATTACHED", previousState: null, newState: null,
    metadata: { type, targetType, targetId: String(targetId) },
  });

  return { ok: true };
}

/** Advances the event's own status. This never touches the subject
 *  record — a BusinessEvent's status is a read-through summary of "where
 *  the story is," derived from and validated against the subject's real
 *  status, not an independent state machine that could drift from it. */
export async function syncBusinessEventStatus({ orgId, eventId, membership, actorEmail }) {
  const got = await getBusinessEvent({ orgId, eventId, membership });
  if (got.error) return got;
  const resolved = await resolveSubject({ orgId, subjectType: got.event.subjectType, subjectId: got.event.subjectId });
  if (resolved.error) return resolved;

  const nextStatus = deriveStatus(got.event.subjectType, resolved.subject);
  if (nextStatus === got.event.status) return { event: got.event, changed: false };

  const { businessEvents } = await getOrgCollections();
  const now = new Date().toISOString();
  const update = { status: nextStatus, updatedAt: now };
  if (["EXECUTED", "CLOSED"].includes(nextStatus)) update.completedAt = now;
  await businessEvents.updateOne({ _id: got.event._id }, { $set: update });

  await logOrgActivity({
    orgId, recordType: "BUSINESS_EVENT", recordId: got.event._id, actorEmail,
    action: "EVENT_STATUS_SYNCED", previousState: got.event.status, newState: nextStatus, metadata: {},
  });

  return { event: { ...got.event, ...update }, changed: true };
}

function deriveStatus(subjectType, subject) {
  const s = subject.status;
  if (subjectType === "INVOICE") {
    if (s === "PAID") return "EXECUTED";
    if (s === "CANCELLED") return "CLOSED";
    if (s === "SENT" || s === "OVERDUE") return "DECIDED";
    return "OPEN";
  }
  if (subjectType === "PURCHASE_ORDER") {
    if (s === "RECEIVED") return "EXECUTED";
    if (["REJECTED", "CANCELLED"].includes(s)) return "CLOSED";
    if (["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(s)) return "DECIDED";
    return "OPEN";
  }
  if (subjectType === "PURCHASE_REQUEST") {
    if (s === "APPROVED") return "DECIDED";
    if (["REJECTED", "CANCELLED"].includes(s)) return "CLOSED";
    return "OPEN";
  }
  if (subjectType === "AI_ACTION_REQUEST") {
    if (s === "EXECUTED") return "EXECUTED";
    if (["REJECTED", "EXPIRED", "CANCELLED"].includes(s)) return "CLOSED";
    if (["APPROVED", "QUEUED"].includes(s)) return "DECIDED";
    return "OPEN";
  }
  return "OPEN";
}

/** Builds the auditor timeline (SOW §16): merges org_activity for the
 *  event itself with org_activity for the subject and every relationship
 *  target the caller is permitted to see. Every entry here is a real
 *  activity record that already existed — nothing is synthesized. */
export async function getBusinessEventTimeline({ orgId, eventId, membership }) {
  const got = await getBusinessEvent({ orgId, eventId, membership });
  if (got.error) return got;
  const event = got.event;

  const sources = [{ recordType: "BUSINESS_EVENT", recordId: event._id }, { recordType: event.subjectType, recordId: event.subjectId }];
  for (const rel of event.relationships || []) {
    sources.push({ recordType: rel.targetType, recordId: rel.targetId });
  }

  const entries = [];
  for (const src of sources) {
    const found = await listOrgActivityForRecord({ orgId, recordType: src.recordType, recordId: src.recordId });
    entries.push(...found);
  }
  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return { timeline: entries };
}
