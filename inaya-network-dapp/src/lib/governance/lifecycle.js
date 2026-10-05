// src/lib/governance/lifecycle.js
//
// Runs the time-based part of PUBLISHED governance policies (GOV-003). retention.js stops removal too early; this job acts when the period has ended:
//   retention policy  {days, afterAction}   once an object is `days` old: "review" (tell the administrators, change nothing), "archive" (APPROVED -> ARCHIVED, reversible)
//                                           or "delete" (hide it as an S3 delete does: deletedAt, bytes untouched), within the policy's scope
//   archival policy   {afterDaysInactive}   archive an APPROVED document nobody has touched for that long
// Safety: nothing under legal hold, retention lock, a file lock or a legal-hold policy is touched; one action per object per policy (a marker is written), so a rerun
// does nothing twice; work is bounded per run and per organization; every action is written to the activity log; "delete" only runs when a policy explicitly says so.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { effectivePolicies } from "./policies.js";
import { retentionBlock } from "./retention.js";
import { logOrgActivity } from "../org-activity-log.js";

const DAY = 86400_000;
const ts = (v) => (v ? new Date(v).getTime() : 0);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function isProtected(doc, orgId, now) {
  if (doc.legalHold) return true;
  if (doc.retentionUntil && ts(doc.retentionUntil) > now.getTime()) return true;
  if (doc.lock && doc.lock.expiresAt && ts(doc.lock.expiresAt) > now.getTime()) return true;
  // the permanent class and legal-hold policies; the age rule is this job's own business, so the object is presented as very old
  return !!(await retentionBlock({ orgId, doc: { ...doc, createdAt: new Date(0).toISOString() }, now }));
}

/** One organization. Returns counts per action. */
export async function runOrgLifecycle({ orgId, now = new Date(), limit = 200 }) {
  const { orgDocuments } = await getOrgCollections(); const oid = toObjectId(orgId);
  const out = { reviewed: 0, archived: 0, deleted: 0, skippedProtected: 0 };
  const [retention, archival] = await Promise.all([effectivePolicies({ orgId, type: "retention", ctx: null, now }), effectivePolicies({ orgId, type: "archival", ctx: null, now })]);
  let budget = limit; const review = new Map();
  for (const { p, kind } of [...retention.map((p) => ({ p, kind: "retention" })), ...archival.map((p) => ({ p, kind: "archival" }))]) {
    if (budget <= 0) break;
    const days = kind === "retention" ? Number(p.config?.days) : Number(p.config?.afterDaysInactive); if (!Number.isFinite(days) || days <= 0) continue;
    const action = kind === "retention" ? p.config?.afterAction : "archive"; const key = `lifecycle.${p.policyKey}`;
    const cutoff = new Date(now.getTime() - days * DAY).toISOString(); const scope = p.scope || {};
    const q = { orgId: oid, deletedAt: null, isLatest: { $ne: false }, [key]: { $exists: false } };
    if (kind === "archival") { q.status = "APPROVED"; q.$or = [{ updatedAt: { $lte: cutoff } }, { updatedAt: { $exists: false }, createdAt: { $lte: cutoff } }]; } else q.createdAt = { $lte: cutoff };
    if (scope.pathPrefix) q.filename = { $regex: `^${escapeRe(scope.pathPrefix)}` };
    if (Array.isArray(scope.departmentIds) && scope.departmentIds.length) q.departmentId = { $in: scope.departmentIds.map((d) => toObjectId(d)) };
    for (const doc of await orgDocuments.find(q).limit(Math.min(budget, 100)).toArray()) {
      budget--; const marker = { at: now.toISOString(), action };
      if (action !== "review" && (await isProtected(doc, orgId, now))) { out.skippedProtected++; continue; }
      if (action === "review") {
        await orgDocuments.updateOne({ _id: doc._id, [key]: { $exists: false } }, { $set: { [key]: marker, lifecycleReview: { policyKey: p.policyKey, at: marker.at } } });
        const label = p.name || p.policyKey; if (!review.has(label)) review.set(label, 0); review.set(label, review.get(label) + 1); out.reviewed++;
      } else if (action === "archive") {
        const r = await orgDocuments.updateOne({ _id: doc._id, status: "APPROVED", [key]: { $exists: false } }, { $set: { status: "ARCHIVED", updatedAt: now.toISOString(), [key]: marker } });
        if (!r.modifiedCount) { await orgDocuments.updateOne({ _id: doc._id }, { $set: { [key]: { ...marker, action: "none: not approved" } } }); continue; }
        out.archived++; await logOrgActivity({ orgId, recordType: "DOCUMENT", recordId: doc._id, actorEmail: "governance-lifecycle", action: "ARCHIVED_BY_POLICY", previousState: "APPROVED", newState: "ARCHIVED", metadata: { policy: p.policyKey, kind } });
      } else if (action === "delete") {
        const r = await orgDocuments.updateOne({ _id: doc._id, deletedAt: null, [key]: { $exists: false } }, { $set: { deletedAt: now.toISOString(), [key]: marker } });
        if (r.modifiedCount) { out.deleted++; await logOrgActivity({ orgId, recordType: "DOCUMENT", recordId: doc._id, actorEmail: "governance-lifecycle", action: "DELETED_BY_RETENTION_POLICY", previousState: null, newState: null, metadata: { policy: p.policyKey, days } }); }
      }
    }
  }
  if (review.size) {
    try {
      const { notifyEvent } = await import("../notify/router.js"); const n = [...review.values()].reduce((a, v) => a + v, 0);
      await notifyEvent({ orgId, event: "governance.review", audience: "admins", title: "Documents need a retention review", body: `${n} document(s) reached the end of their retention period under: ${[...review.keys()].join(", ")}.`, protectedContent: false, dedupeKey: `lifecycle-review:${orgId}:${now.toISOString().slice(0, 10)}`, link: "/business?view=governance" });
    } catch { /* the review flags are already written */ }
  }
  return out;
}

/** Every organization that has a published retention or archival policy. */
export async function runGovernanceLifecycle({ now = new Date(), perOrgLimit = 200, orgLimit = 200 } = {}) {
  const { db } = await getOrgCollections(); const orgIds = await db.collection("governance_policies").distinct("orgId", { type: { $in: ["retention", "archival"] }, status: "published" });
  const total = { orgs: 0, reviewed: 0, archived: 0, deleted: 0, skippedProtected: 0 };
  for (const oid of orgIds.slice(0, orgLimit)) { const r = await runOrgLifecycle({ orgId: String(oid), now, limit: perOrgLimit }); total.orgs++; for (const k of ["reviewed", "archived", "deleted", "skippedProtected"]) total[k] += r[k]; }
  return total;
}
