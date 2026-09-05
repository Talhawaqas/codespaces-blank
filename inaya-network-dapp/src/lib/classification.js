// src/lib/classification.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.3) — data classification.
// This is a NARROWING-ONLY layer on top of document-permissions.js's
// existing resolveLevel(), never a replacement for it: a document/record
// still needs an ordinary VIEW/EDIT/MANAGE grant (or department/project
// implicit access) to be visible at all. Classification can only take
// access AWAY from what resolveLevel() would otherwise grant — a sensitive
// classification forces "explicit grant (or care-team/matter-team
// assignment) only," overriding the DEPARTMENT-implies-EDIT default that
// applies to ordinary, unclassified documents. It can never grant MORE
// access than resolveLevel() already computed.
//
// Levels are org-configurable (stored in data_classifications), but every
// org gets these seeded defaults on first use — the SOW's own §4.3 list.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";

export const DEFAULT_CLASSIFICATION_LEVELS = [
  { key: "PUBLIC", label: "Public", restricted: false },
  { key: "INTERNAL", label: "Internal", restricted: false },
  { key: "CONFIDENTIAL", label: "Confidential", restricted: false },
  { key: "HIGHLY_CONFIDENTIAL", label: "Highly Confidential", restricted: true },
  { key: "RESTRICTED", label: "Restricted", restricted: true },
  { key: "REGULATED", label: "Regulated", restricted: true },
  { key: "PRIVILEGED", label: "Privileged", restricted: true },
  { key: "PATIENT_SENSITIVE", label: "Patient Sensitive", restricted: true },
  { key: "EVIDENCE", label: "Evidence", restricted: true },
  { key: "ATTORNEY_WORK_PRODUCT", label: "Attorney Work Product", restricted: true },
];

/** Returns this org's configured classification levels, seeding the
 *  defaults on first read (idempotent — findOneAndUpdate with
 *  $setOnInsert, same discipline as notifications.js's dedupeKey upsert). */
export async function getOrgClassificationLevels(orgId) {
  const { dataClassifications } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const existing = await dataClassifications.find({ orgId: orgObjectId }).toArray();
  if (existing.length) return existing;

  await Promise.all(
    DEFAULT_CLASSIFICATION_LEVELS.map((level, index) =>
      dataClassifications.findOneAndUpdate(
        { orgId: orgObjectId, key: level.key },
        { $setOnInsert: { orgId: orgObjectId, ...level, sortOrder: index, createdAt: new Date().toISOString() } },
        { upsert: true }
      )
    )
  );
  return dataClassifications.find({ orgId: orgObjectId }).sort({ sortOrder: 1 }).toArray();
}

/** The narrowing check itself. `baseLevel` is whatever document-
 *  permissions.js's resolveLevel() (or an equivalent per-vertical
 *  resolver) already computed from ordinary grants/department/project
 *  access. `classification` is the record's classification key (or null/
 *  undefined for an unclassified record, which never narrows anything).
 *  `hasExplicitAccess` is true when the caller has an explicit permission
 *  grant OR a care-team/matter-team assignment for this specific record —
 *  callers pass this in since only they know which assignment mechanism
 *  applies to their record type.
 *
 *  Returns the (possibly narrowed) level — never a level higher than
 *  baseLevel. Org owner/admin are never narrowed, matching every other
 *  gate in this codebase's "owner/admin see everything" invariant. */
export function resolveClassificationAccess({ membership, baseLevel, classification, levels, hasExplicitAccess }) {
  if (!baseLevel || baseLevel === "NONE") return baseLevel;
  if (canManageOrg(membership)) return baseLevel;
  if (!classification) return baseLevel;

  const levelDef = (levels || DEFAULT_CLASSIFICATION_LEVELS).find((l) => l.key === classification);
  if (!levelDef?.restricted) return baseLevel;

  // Restricted classification: implicit department/project access is not
  // enough. Only an explicit grant or a care-team/matter-team assignment
  // (or being the record's own owner/uploader, which resolveLevel() would
  // already have factored into baseLevel before this function is called)
  // preserves access — everyone else is narrowed to no access at all.
  return hasExplicitAccess ? baseLevel : "NONE";
}
