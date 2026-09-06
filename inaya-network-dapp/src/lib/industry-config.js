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
// `industry`/`vertical` gates the Health/Legal NAV_ITEMS entries in
// business/page.js (an org not configured as "healthcare" or "legal"
// simply never sees those nav items) AND, via requireVertical() below,
// every Health/Legal API route — a law firm or general business cannot
// reach a Health OS route (or vice versa) even by calling the API
// directly, not just by the nav item being hidden. This is layered on
// TOP of, not instead of, getAccessibleScope() + classification.js + the
// role gates — those still govern which specific records within an
// approved vertical a given member can see.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";

export const ORG_VERTICALS = ["general", "healthcare", "legal", "regulated", "financial", "private_capital"];

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

const VERTICAL_LABELS = {
  healthcare: "Health OS", legal: "Legal OS", regulated: "Regulated Enterprise OS",
  financial: "Financial Services OS", private_capital: "Private Capital OS",
};

/** The hard door-lock, called from every Health/Legal/Regulated/Financial
 *  API route right after requireMembership(). Returns { error, status:
 *  403 } unless the org's configured vertical matches exactly — a
 *  "general" org, or a legal org calling a health route (or vice versa),
 *  is rejected before any domain logic runs, regardless of the caller's
 *  role within the org. Fails closed: an org with no profile at all
 *  (shouldn't happen once getOrgProfile's defaults apply, but checked
 *  explicitly) is treated as "general" — never treated as a match by
 *  accident.
 *
 *  `expectedVertical` may be a single string or an array of strings —
 *  the Financial Entity Core (Phase 1) is genuinely shared by both the
 *  "financial" (hedge funds/asset managers) and "private_capital"
 *  (PE/VC) verticals per the SOW's own Phase 1 scope, so its routes need
 *  to accept either without duplicating every route two ways. */
export async function requireVertical(orgId, expectedVertical) {
  const profile = await getOrgProfile(orgId);
  const actual = profile?.vertical || "general";
  const allowed = Array.isArray(expectedVertical) ? expectedVertical : [expectedVertical];
  if (!allowed.includes(actual)) {
    const label = allowed.map((v) => VERTICAL_LABELS[v] || v).join(" or ");
    return { error: `This organization isn't configured for ${label} — an owner/admin can change this under Settings.`, status: 403 };
  }
  return { ok: true };
}
