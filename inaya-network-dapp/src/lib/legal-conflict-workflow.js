// src/lib/legal-conflict-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 6 (§11.6) — conflict checking.
// A search across clients/prospects/former (deletedAt-set) clients/
// matters (for opposing-party name matches), NOT a definitive legal
// clearance — the SOW says this explicitly, and the result object's own
// shape (`status: "potential" | "cleared" | "escalated"`, always
// requiring a human reviewer to move it out of "potential") is designed
// so no caller can mistake an automated match/no-match for a real
// clearance decision.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

function normalizeName(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
}

/** Runs the search itself — pure read, no state written. Exact + normalized
 *  name matching only (no fuzzy/phonetic matching, which risks both false
 *  negatives presented as false confidence and is a much larger, separate
 *  scope than this SOW asks for) across clients, prospects, and matters'
 *  opposingParties/parties arrays. */
export async function searchConflicts({ orgId, names }) {
  const { legalClients, legalProspects, legalMatters } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const normalizedNames = (names || []).map(normalizeName).filter(Boolean);
  if (!normalizedNames.length) return { matches: [] };

  const [clients, prospects, matters] = await Promise.all([
    legalClients.find({ orgId: orgObjectId }).toArray(),
    legalProspects.find({ orgId: orgObjectId }).toArray(),
    legalMatters.find({ orgId: orgObjectId }).toArray(),
  ]);

  const matches = [];
  for (const c of clients) {
    if (normalizedNames.includes(normalizeName(c.name))) matches.push({ type: c.deletedAt ? "former_client" : "client", recordId: c._id, name: c.name });
  }
  for (const p of prospects) {
    if (normalizedNames.includes(normalizeName(p.name))) matches.push({ type: "prospect", recordId: p._id, name: p.name });
  }
  for (const m of matters) {
    for (const party of m.opposingParties || []) {
      if (normalizedNames.includes(normalizeName(party))) matches.push({ type: "opposing_party", recordId: m._id, name: party, matterName: m.name });
    }
  }
  return { matches };
}

/** Records the search + a human reviewer's disposition of it. The search
 *  (searchConflicts) and the recorded decision are deliberately separate
 *  calls — a reviewer must look at the actual matches before this
 *  function is ever invoked with a real "cleared"/"escalated" status. */
export async function recordConflictCheck({ orgId, matterName, namesChecked, matches, status, reviewerEmail, notes, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to record a conflict check.", status: 403 };
  if (!["potential", "cleared", "escalated"].includes(status)) return { error: `Unknown status "${status}".`, status: 400 };

  const { legalConflictChecks } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterName: matterName || null, namesChecked: namesChecked || [],
    matches: matches || [], status, reviewerEmail: reviewerEmail || null, notes: notes || "",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalConflictChecks.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "CONFLICT_CHECK", recordId: inserted._id, actorEmail, action: "RECORDED", previousState: null, newState: status, metadata: { matchCount: (matches || []).length } });
  return { conflictCheck: inserted };
}
