// src/lib/growth/segments.js -- Inaya Commerce Phase 4 (Master SOW 8.6): commerce use of the marketing segments.
// Segments themselves live in the Email Campaigns module (src/lib/engagement/segments.js), extended with commerce rules
// (purchase recency, spend, orders, category, branch, loyalty tier, customer type, at-risk, engagement) and a version
// history. Dynamic segments are evaluated at the moment they are used (send time, till time), so they are always
// current -- the "refresh schedule" is continuous; static segments are a fixed list of people.
import { toObjectId } from "../orgs.js";
import { engagementCollections } from "../engagement/store.js";
import { resolveAudience, normalizeRules } from "../engagement/segments.js";
import { logOrgActivity } from "../org-activity-log.js";

async function loadSegment(orgId, segmentId) { const { marketing } = await engagementCollections(); return marketing.findOne({ _id: toObjectId(segmentId), orgId: toObjectId(orgId), kind: "segment" }); }

/** Is this customer in the segment right now? (segments are email audiences: a customer without an email is not in one) */
export async function inSegment(orgId, segmentId, customer) {
  const seg = await loadSegment(orgId, segmentId); if (!seg || !customer?.email) return false;
  const id = String(customer._id);
  if (seg.rules?.staticContactIds && !seg.rules.staticContactIds.includes(id)) return false;
  const a = await resolveAudience(orgId, { ...seg.rules, staticContactIds: [id] }, { limit: 5 });
  return a.recipients.some((r) => String(r.contactId) === id);
}

/** CSV export of a segment: marketing managers only, suppressed people never included, name + email only (no phone,
 *  no purchase data), and every export is recorded. */
export async function exportSegment({ orgId, membership, actorEmail, segmentId }) {
  const { canManageMarketing } = await import("../engagement/store.js");
  if (!canManageMarketing(membership)) return { error: "Only a marketing manager can export a segment.", status: 403 };
  const seg = await loadSegment(orgId, segmentId); if (!seg) return { error: "Segment not found.", status: 404 };
  const v = normalizeRules(seg.rules || {}); if (v.error) return { error: v.error, status: 400 };
  const a = await resolveAudience(orgId, v.rules, { limit: 50000 });
  const esc = (s) => { const x = String(s ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const csv = ["name,email", ...a.recipients.map((r) => `${esc(r.name)},${esc(r.email)}`)].join("\n");
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "SEGMENT", recordId: seg._id, actorEmail, action: "SEGMENT_EXPORTED", previousState: null, newState: null, metadata: { name: seg.name, rows: a.recipients.length, suppressedExcluded: a.suppressedCount } }).catch(() => {});
  return { csv, filename: `${String(seg.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`, rows: a.recipients.length };
}
