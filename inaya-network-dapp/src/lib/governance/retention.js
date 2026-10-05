// src/lib/governance/retention.js
//
// Enforces PUBLISHED governance policies on the destructive storage paths (GOV-003). Before a stored object is deleted, overwritten in place or expired by a lifecycle rule,
// the storage chokepoint (src/lib/s3-compat/store.js) asks whether any of these applies:
//   * metadata retention_class "permanent": never deletable;
//   * a published `retention` policy whose scope matches: the object cannot be removed until it is `days` old;
//   * a published `legal_hold` policy with blockDeletion: true whose scope matches: nothing in scope can be removed.
// These stack on top of the per-object legal hold and retention lock that already existed; none of them loosens them. A policy that does not match the object's scope
// (department, path prefix) has no effect on it. The check never throws for a lookup problem on its own account: if policies cannot be read it FAILS CLOSED for
// objects that carry a permanent class and otherwise lets the existing object-level protections decide.

import { effectivePolicies } from "./policies.js";

const DAY = 86400_000;

/** Returns null when removal is allowed, or { reason, message, until? } when a policy blocks it. */
export async function retentionBlock({ orgId, doc, now = new Date() }) {
  if (!doc) return null;
  if (doc.metadata?.retention_class === "permanent") return { reason: "PermanentRetention", message: "this object has the permanent retention class" };
  let retention = [], holds = [];
  try {
    const ctx = { departmentId: String(doc.departmentId ?? ""), path: String(doc.filename ?? "") };
    [retention, holds] = await Promise.all([effectivePolicies({ orgId, type: "retention", ctx, now }), effectivePolicies({ orgId, type: "legal_hold", ctx, now })]);
  } catch { return null; }
  for (const h of holds) if (h.config?.blockDeletion === true) return { reason: "PolicyLegalHold", message: `a legal-hold policy (${h.name || h.policyKey}) blocks deletion` };
  const born = new Date(doc.createdAt || doc.uploadedAt || 0).getTime();
  for (const r of retention) {
    const days = Number(r.config?.days); if (!Number.isFinite(days) || !born) continue;
    const until = born + days * DAY; if (until > now.getTime()) return { reason: "PolicyRetention", message: `a retention policy (${r.name || r.policyKey}) keeps it until ${new Date(until).toISOString().slice(0, 10)}`, until: new Date(until).toISOString() };
  }
  return null;
}
