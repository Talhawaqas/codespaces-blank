// src/lib/identity/reviews.js
//
// SOW §31: periodic access certification. A CAMPAIGN lists, per person, who has access, why (each grant with its source), since when,
// until when, and to which resources. A reviewer decides per person:
//     APPROVE  keep as is         MODIFY  remove specific grants        REVOKE  remove all access (full revocation, verified)
// Every decision is audited and recorded as a run. A REVOKE goes through the same revocation state machine as a leaver.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail } from "./common.js";
import { explainAccess, revokeGrants, materialize } from "./grants.js";
import { revokeAccess } from "./revocation.js";
import { recordRun } from "./runs.js";
import { audit, notifyManagers } from "./record.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

export async function createCampaign({ orgId, name, scope = {}, dueInDays = 14, actorEmail }) {
  const nm = String(name || "").trim().slice(0, 100); if (nm.length < 3) return fail("A campaign name is required.");
  const due = new Date(Date.now() + Math.min(180, Math.max(1, Number(dueInDays) || 14)) * 86400000).toISOString();
  const { orgMembers } = await getOrgCollections(); const { identityReviews, identityReviewItems } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId), status: "active" };
  if (scope.role) q.role = scope.role;
  if (scope.departmentId) { const d = oidOf(scope.departmentId); if (!d) return fail("scope.departmentId is invalid."); q.departmentIds = d; }
  const members = await orgMembers.find(q).toArray();
  const campaign = { orgId: toObjectId(orgId), name: nm, scope: { role: scope.role || null, departmentId: scope.departmentId || null, source: scope.source || null, includeOwners: scope.includeOwners === true }, status: "OPEN", dueAt: due, createdBy: normEmail(actorEmail), createdAt: nowIso(), totals: { items: 0, decided: 0 } };
  campaign._id = (await identityReviews.insertOne(campaign)).insertedId;
  let items = 0;
  for (const m of members) {
    if (m.role === "owner" && !campaign.scope.includeOwners) continue;
    const ex = await explainAccess({ orgId, email: m.email });
    const grants = ex.grants.filter((g) => g.status === "ACTIVE" || g.status === "PENDING_APPROVAL");
    if (scope.source && !grants.some((g) => g.source === scope.source)) continue;
    await identityReviewItems.updateOne({ reviewId: campaign._id, email: m.email }, { $setOnInsert: { orgId: toObjectId(orgId), reviewId: campaign._id, email: m.email, role: m.role, snapshot: { role: m.role, grants: grants.map((g) => ({ id: g.id, kind: g.kind, value: g.value, label: g.label, source: g.sourceLabel, since: g.since, until: g.until, reason: g.reason })), lastLogin: null }, status: "PENDING", createdAt: nowIso() } }, { upsert: true });
    items++;
  }
  await identityReviews.updateOne({ _id: campaign._id }, { $set: { "totals.items": items } });
  await audit({ orgId, action: "IDENTITY_REVIEW_CREATED", actorEmail, metadata: { reviewId: String(campaign._id), items, dueAt: due } });
  await notifyManagers({ orgId, title: `Access review "${nm}" opened`, body: `${items} people to certify by ${due.slice(0, 10)}.`, dedupeKey: `identity:review:${campaign._id}:open` });
  return { review: { reviewId: String(campaign._id), name: nm, status: "OPEN", dueAt: due, items } };
}

export async function listCampaigns({ orgId }) {
  const { identityReviews } = await getIdentityCollections();
  const rows = await identityReviews.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).limit(50).toArray();
  return { reviews: rows.map((r) => ({ reviewId: String(r._id), name: r.name, status: r.status, dueAt: r.dueAt, createdAt: r.createdAt, createdBy: r.createdBy, items: r.totals.items, decided: r.totals.decided, overdue: r.status === "OPEN" && Date.parse(r.dueAt) < Date.now() })) };
}

export async function getCampaign({ orgId, reviewId }) {
  const id = oidOf(reviewId); if (!id) return null;
  const { identityReviews, identityReviewItems } = await getIdentityCollections();
  const r = await identityReviews.findOne({ _id: id, orgId: toObjectId(orgId) }); if (!r) return null;
  const items = await identityReviewItems.find({ reviewId: id }).sort({ email: 1 }).toArray();
  return { review: { reviewId: String(r._id), name: r.name, status: r.status, dueAt: r.dueAt, items: r.totals.items, decided: r.totals.decided }, items: items.map((i) => ({ itemId: String(i._id), email: i.email, role: i.role, status: i.status, grants: i.snapshot.grants, decision: i.decision || null, decidedBy: i.decidedBy || null, decidedAt: i.decidedAt || null, note: i.note || null })) };
}

/** decision: APPROVE | MODIFY (with removeGrantIds) | REVOKE. Reviewers are owners/admins. */
export async function decide({ orgId, reviewId, itemId, decision, removeGrantIds = [], note = "", actorEmail, membership }) {
  if (!canManageOrg(membership)) return fail("Only an owner or admin can decide an access review.", 403);
  if (!["APPROVE", "MODIFY", "REVOKE"].includes(decision)) return fail("decision must be APPROVE, MODIFY or REVOKE.");
  const { identityReviews, identityReviewItems, identityGrants } = await getIdentityCollections();
  const rid = oidOf(reviewId); const iid = oidOf(itemId); if (!rid || !iid) return fail("Review item not found.", 404);
  const review = await identityReviews.findOne({ _id: rid, orgId: toObjectId(orgId), status: "OPEN" });
  if (!review) return fail("Review not found, or already closed.", 404);
  const item = await identityReviewItems.findOne({ _id: iid, reviewId: rid, status: "PENDING" });
  if (!item) return fail("That item was already decided.", 409);
  if (normEmail(actorEmail) === item.email) return fail("Nobody can certify their own access.", 403, { reasonCode: "SELF_REVIEW" });
  let result = {}; let state = "COMPLETED";
  if (decision === "MODIFY") {
    if (!Array.isArray(removeGrantIds) || !removeGrantIds.length) return fail("MODIFY needs removeGrantIds.");
    const ids = removeGrantIds.map(oidOf).filter(Boolean);
    const r = await identityGrants.updateMany({ _id: { $in: ids }, orgId: toObjectId(orgId), email: item.email, status: { $in: ["ACTIVE", "PENDING_APPROVAL"] } }, { $set: { status: "REVOKED", revokedAt: nowIso(), revokedReason: `access review ${review.name} by ${actorEmail}` } });
    const m = await materialize({ orgId, email: item.email });
    result = { removed: r.modifiedCount, effective: m.effective || null };
  } else if (decision === "REVOKE") {
    const r = await revokeAccess({ orgId, email: item.email, trigger: "access_review", reason: `Access review "${review.name}"`, actor: actorEmail, mode: "full" });
    if (r.error) return r;
    result = { revocation: r.revocation }; if (r.revocation.state !== "REVOCATION_COMPLETE") state = "PARTIAL";
  }
  const upd = await identityReviewItems.findOneAndUpdate({ _id: iid, status: "PENDING" }, { $set: { status: "DECIDED", decision, decidedBy: normEmail(actorEmail), decidedAt: nowIso(), note: String(note).slice(0, 300), result } });
  if (!upd) return fail("That item was already decided.", 409);
  await identityReviews.updateOne({ _id: rid }, { $inc: { "totals.decided": 1 } });
  const left = await identityReviewItems.countDocuments({ reviewId: rid, status: "PENDING" });
  if (!left) await identityReviews.updateOne({ _id: rid }, { $set: { status: "CLOSED", closedAt: nowIso() } });
  await recordRun({ orgId, type: "REVIEW_REVOKE", email: item.email, actor: actorEmail, state, plan: { ops: [{ op: `REVIEW_${decision}`, reviewId: String(rid) }] }, result, reasonNote: note });
  await audit({ orgId, action: `IDENTITY_REVIEW_${decision}`, actorEmail, metadata: { reviewId: String(rid), email: item.email, note: String(note).slice(0, 100) } });
  return { decided: true, decision, closed: !left, result };
}

/** Worker: reminds owners about campaigns past their due date (once per campaign). */
export async function remindOverdue({ now = Date.now() } = {}) {
  const { identityReviews } = await getIdentityCollections();
  const rows = await identityReviews.find({ status: "OPEN", dueAt: { $lte: new Date(now).toISOString() } }).limit(100).toArray();
  for (const r of rows) await notifyManagers({ orgId: r.orgId, title: `Access review overdue: ${r.name}`, body: `${r.totals.items - r.totals.decided} people still need a decision.`, severity: "warning", dedupeKey: `identity:review:${r._id}:overdue` });
  return { reminded: rows.length };
}
