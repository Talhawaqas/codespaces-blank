// src/lib/nas/common.js
//
// Shared plumbing for every NAS module: permission gates, safe lookups that
// always scope by organization (tenant isolation, SOW 37/38), the agent
// handle, and manager notifications. Nothing here is a second identity or
// permission system -- it wraps orgGates.js (canManageNAS / canAccessNAS).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageNAS, canAccessNAS } from "../orgGates.js";
import { createNotification } from "../notifications.js";
import { NasAgentClient } from "./agent.js";

export const SYNTHETIC_OWNER = { role: "owner" }; // a system action is not gated by the caller's own role

export function fail(error, status = 400, extra = {}) {
  return { error, status, ...extra };
}

/** Returns an error object when the caller lacks the gate, else null. */
export function gate(membership, manage) {
  const ok = manage ? canManageNAS(membership) : canAccessNAS(membership);
  if (ok) return null;
  return fail(manage ? "Only a NAS manager can do that." : "You don't have NAS access.", 403);
}

export function iso(d = new Date()) {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

export function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000);
}

export function idStr(v) {
  return v == null ? null : String(v);
}

/** Resolves an appliance of THIS org (never another org's) plus its agent. */
export async function loadAppliance({ orgId, applianceId }) {
  let _id;
  try { _id = toObjectId(applianceId); } catch { return fail("Appliance not found.", 404); }
  const { nasAppliances } = await getOrgCollections();
  const appliance = await nasAppliances.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!appliance) return fail("Appliance not found.", 404);
  return { appliance, agent: new NasAgentClient({ backend: appliance.backend }) };
}

/** Resolves a share, its appliance and the agent, all scoped to the org. */
export async function loadShare({ orgId, shareId }) {
  let _id;
  try { _id = toObjectId(shareId); } catch { return fail("Share not found.", 404); }
  const { nasShares } = await getOrgCollections();
  const share = await nasShares.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!share) return fail("Share not found.", 404);
  const res = await loadAppliance({ orgId, applianceId: share.applianceId });
  if (res.error) return res;
  return { share, appliance: res.appliance, agent: res.agent };
}

/** Every NAS manager: org owners/admins and members holding nasRole manager. */
export async function listNasManagers(orgId) {
  const { orgMembers } = await getOrgCollections();
  const rows = await orgMembers.find({ orgId: toObjectId(orgId), status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { nasRole: "manager" }] }).toArray();
  return rows.map((m) => m.email).filter(Boolean);
}

/** Idempotent (dedupeKey) notification to every NAS manager. Never throws. */
export async function notifyNasManagers({ orgId, type, severity = "warning", title, body, dedupeKey, sourceId }) {
  try {
    const targets = await listNasManagers(orgId);
    for (const email of targets) {
      await createNotification({
        scope: "org", orgId, targetEmail: email, category: "business", severity, type, title, body,
        sourceModule: "nas", sourceId, actionUrl: "/business?view=nas", dedupeKey: dedupeKey ? `${dedupeKey}:${email}` : undefined, metadata: {},
      });
    }
    return targets.length;
  } catch (e) {
    console.error("notifyNasManagers failed (non-fatal):", e.message);
    return 0;
  }
}

/** Accepts only a simple string; used to keep ids/names in evidence small. */
export function clip(value, n = 200) {
  return value == null ? null : String(value).slice(0, n);
}
