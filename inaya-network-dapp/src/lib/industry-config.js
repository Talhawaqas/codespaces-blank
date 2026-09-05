// src/lib/industry-config.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.1) — organization profile.
// Confirmed via codebase audit that orgs.js's `orgs` collection today only
// holds {name, ownerEmail, createdAt} — none of these fields exist yet.
// This module owns reading/writing them; it does NOT introduce a second
// "org config" collection — these are plain fields on the existing `orgs`
// document, same collection every other module already reads via
// `orgs.findOne({_id: orgObjectId})`.
//
// `industry`/`vertical` is what gates the Health/Legal NAV_ITEMS entries
// in business/page.js (an org not configured as "healthcare" or "legal"
// simply never sees those nav items — this is a UI convenience gate, NOT
// a security boundary; the real security boundary is getAccessibleScope()
// + classification.js + the role gates, which apply regardless of what
// nav items are shown).

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";

export const ORG_VERTICALS = ["general", "healthcare", "legal"];

const DEFAULT_PROFILE = {
  vertical: "general",
  industry: null,
  organizationType: null,
  locations: [],
  timeZone: "UTC",
  workingHours: null,
  branding: {},
  retentionPolicy: {},
  securityPolicy: {},
  aiPolicy: { enabled: true },
  notificationPolicy: {},
  exportPolicy: {},
};

export async function getOrgProfile(orgId) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) });
  if (!org) return null;
  // Merge over defaults rather than assuming every field is present — an
  // org created before this module existed has none of these fields set.
  return { ...DEFAULT_PROFILE, ...org };
}

export async function updateOrgProfile({ orgId, updates, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update organization settings.", status: 403 };
  if (updates.vertical && !ORG_VERTICALS.includes(updates.vertical)) {
    return { error: `Unknown vertical "${updates.vertical}".`, status: 400 };
  }
  const { orgs } = await getOrgCollections();
  const allowedFields = Object.keys(DEFAULT_PROFILE);
  const setDoc = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) setDoc[key] = updates[key];
  }
  setDoc.updatedAt = new Date().toISOString();
  setDoc.updatedByEmail = actorEmail;

  const updated = await orgs.findOneAndUpdate(
    { _id: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Organization not found.", status: 404 };
  return { org: updated };
}
