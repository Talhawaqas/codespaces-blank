// src/lib/docIntelligence/review.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C, §"human review... versioned
// corrections, not silent overwrites". A correction is APPENDED to a result's corrections[] array; the
// original extraction (fields/classification/generated) is never mutated, so the full history of what the
// model said vs. what a human corrected is always reconstructible -- same discipline bookkeeper/review.js
// uses for its mappings, generalized past invoices. Approving/rejecting/correcting all require org
// manage-permission (owner/admin), same gate the SOW's governance section expects for analyzer decisions.

import { toObjectId, canManageOrg } from "../orgs.js";
import { getDocIntelligenceCollections } from "./db.js";
import { fail, nowIso } from "./common.js";
import { audit, event, link, notify } from "./record.js";

const itemView = (i) => ({ itemId: String(i._id), resultId: String(i.resultId), reason: i.reason, severity: i.severity, status: i.status, createdAt: i.createdAt, resolvedBy: i.resolvedBy || null, resolvedAt: i.resolvedAt || null, resolution: i.resolution || null });

export async function openItem({ orgId, departmentId = null, resultId, reason, severity = "medium" }) {
  const c = await getDocIntelligenceCollections();
  const now = nowIso();
  const item = { orgId: toObjectId(orgId), departmentId: departmentId ? toObjectId(departmentId) : null, resultId: toObjectId(resultId), reason: String(reason).slice(0, 300), severity, status: "OPEN", dedupeKey: `result:${resultId}:review`, createdAt: now };
  try { item._id = (await c.diReviewItems.insertOne(item)).insertedId; return item; }
  catch (err) { if (err?.code === 11000) return c.diReviewItems.findOne({ orgId: toObjectId(orgId), dedupeKey: item.dedupeKey, status: "OPEN" }); throw err; }
}

export async function listQueue({ orgId, status = "OPEN", limit = 50, skip = 0 }) {
  const c = await getDocIntelligenceCollections();
  const q = { orgId: toObjectId(orgId) }; if (status) q.status = status;
  const [items, total] = await Promise.all([c.diReviewItems.find(q).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 200)).toArray(), c.diReviewItems.countDocuments(q)]);
  return { items: items.map(itemView), total };
}

export async function getItem({ orgId, itemId }) {
  let oid; try { oid = toObjectId(itemId); } catch { return null; }
  const c = await getDocIntelligenceCollections();
  return c.diReviewItems.findOne({ _id: oid, orgId: toObjectId(orgId) });
}

async function resolve(orgId, item, actorEmail, resolution) {
  const c = await getDocIntelligenceCollections();
  await c.diReviewItems.updateOne({ _id: item._id }, { $set: { status: "RESOLVED", resolvedBy: actorEmail, resolvedAt: nowIso(), resolution } });
}

/** Overlays the latest correction per field onto the raw extracted fields -- the raw extraction is never
 *  mutated; this is a read-time projection so "what the system saw" and "what is now believed" both survive. */
export function currentFields(result) {
  const fields = JSON.parse(JSON.stringify(result.fields || {}));
  for (const corr of result.corrections || []) fields[corr.field] = { value: corr.value, confidence: 1, source: "human", grounded: null, correctedBy: corr.actor, correctedAt: corr.at };
  return fields;
}

/**
 * act(): approve (accepts the extraction/classification/generation as-is), edit (applies one or more
 * versioned field corrections), reject (marks the result REJECTED -- it stays, it is just no longer trusted).
 */
export async function act({ orgId, itemId, action, body = {}, membership, actorEmail }) {
  if (!["approve", "edit", "reject"].includes(action)) return fail("action must be one of approve, edit, reject.");
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can review a document intelligence result.", 403);
  const item = await getItem({ orgId, itemId }); if (!item) return fail("Review item not found.", 404);
  if (item.status !== "OPEN") return fail("This item was already resolved.", 409);
  const c = await getDocIntelligenceCollections(); const oid = toObjectId(orgId);
  const result = await c.diResults.findOne({ _id: item.resultId, orgId: oid });
  if (!result) return fail("The result behind this item no longer exists.", 404);
  await audit({ orgId, recordId: item._id, action: `DOC_INTELLIGENCE_REVIEW_${action.toUpperCase()}`, actorEmail, metadata: { itemId: String(item._id), resultId: String(result._id) } });

  if (action === "approve") {
    await c.diResults.updateOne({ _id: result._id }, { $set: { status: "PROCESSED", humanVerified: true, updatedAt: nowIso() } });
    link({ orgId, subjectId: result._id, type: "APPROVED_BY", targetType: "DI_REVIEW", targetId: result._id, note: `verified by ${actorEmail}` });
    await event({ orgId, type: "REVIEW_APPROVED", recordId: result._id, actorEmail, metadata: { resultId: String(result._id) } });
    await resolve(orgId, item, actorEmail, "approved as extracted"); return { resolved: true };
  }
  if (action === "reject") {
    const reason = String(body.reason || "").trim().slice(0, 200); if (!reason) return fail("A reason is required to reject.");
    await c.diResults.updateOne({ _id: result._id }, { $set: { status: "REJECTED", rejectedReason: reason, updatedAt: nowIso() } });
    await event({ orgId, type: "REVIEW_REJECTED", recordId: result._id, actorEmail, metadata: { resultId: String(result._id), reason } });
    await resolve(orgId, item, actorEmail, `rejected: ${reason}`); return { resolved: true };
  }
  // edit: body.corrections = [{ field, value }]
  const corrections = Array.isArray(body.corrections) ? body.corrections : [];
  if (!corrections.length) return fail("At least one correction is required.");
  const now = nowIso();
  const entries = corrections.slice(0, 60).filter((c2) => c2 && typeof c2.field === "string").map((c2) => ({ field: c2.field.slice(0, 60), oldValue: result.fields?.[c2.field]?.value ?? null, newValue: c2.value, actor: actorEmail, at: now, note: String(c2.note || "").slice(0, 200) }));
  await c.diResults.updateOne({ _id: result._id }, { $push: { corrections: { $each: entries.map((e) => ({ field: e.field, value: e.newValue, actor: e.actor, at: e.at, note: e.note })) } }, $set: { status: "PROCESSED", humanVerified: true, updatedAt: now } });
  link({ orgId, subjectId: result._id, type: "APPROVED_BY", targetType: "DI_REVIEW", targetId: result._id, note: `${entries.length} field(s) corrected by ${actorEmail}` });
  await event({ orgId, type: "REVIEW_CORRECTION_APPLIED", recordId: result._id, actorEmail, previousState: Object.fromEntries(entries.map((e) => [e.field, e.oldValue])), newState: Object.fromEntries(entries.map((e) => [e.field, e.newValue])), metadata: { resultId: String(result._id), fields: entries.map((e) => e.field) } });
  await resolve(orgId, item, actorEmail, `${entries.length} field(s) corrected`);
  notify({ orgId, title: "Document intelligence correction recorded", body: `${entries.length} field(s) corrected on ${result.filename}.`, dedupeKey: `di:corr:${result._id}:${now}`, severity: "info", recordId: result._id });
  return { resolved: true, corrections: entries.length };
}
