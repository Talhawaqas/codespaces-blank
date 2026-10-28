// src/lib/education/settings.js
//
// Per-school settings, kept as an `education` sub-document on the existing
// orgs document (same "no second config collection" rule as
// industry-config.js). Currency follows the country unless set.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageEducation } from "../orgGates.js";

export const EDUCATION_COUNTRIES = {
  PK: { name: "Pakistan", currency: "PKR" },
  IN: { name: "India", currency: "INR" },
  BD: { name: "Bangladesh", currency: "BDT" },
  AE: { name: "United Arab Emirates", currency: "AED" },
};
export const INSTITUTION_TYPES = ["school", "college", "academy", "university", "madrasa", "training_institute"];

const DEFAULTS = { country: "PK", currency: "PKR", institutionType: "school", receiptPrefix: "RCPT", lateFeeMinor: 0, attendanceThreshold: 75 };

export async function getEducationSettings(orgId) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { education: 1, name: 1 } });
  return { ...DEFAULTS, ...(org?.education || {}), schoolName: org?.name || "" };
}

export async function updateEducationSettings({ orgId, updates, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can change school settings.", status: 403 };
  const next = {};
  if (updates.country !== undefined) {
    if (!EDUCATION_COUNTRIES[updates.country]) return { error: "Country must be PK, IN, BD or AE.", status: 400 };
    next.country = updates.country;
    if (updates.currency === undefined) next.currency = EDUCATION_COUNTRIES[updates.country].currency;
  }
  if (updates.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(updates.currency)) return { error: "Currency must be a 3-letter code.", status: 400 };
    next.currency = updates.currency;
  }
  if (updates.institutionType !== undefined) {
    if (!INSTITUTION_TYPES.includes(updates.institutionType)) return { error: "Unknown institution type.", status: 400 };
    next.institutionType = updates.institutionType;
  }
  if (updates.receiptPrefix !== undefined) {
    const p = String(updates.receiptPrefix).trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(p)) return { error: "Receipt prefix: 1–8 letters or digits.", status: 400 };
    next.receiptPrefix = p;
  }
  if (updates.lateFeeMinor !== undefined) {
    const n = Number(updates.lateFeeMinor);
    if (!Number.isInteger(n) || n < 0) return { error: "Late fee must be a whole, non-negative amount in minor units.", status: 400 };
    next.lateFeeMinor = n;
  }
  if (updates.attendanceThreshold !== undefined) {
    const n = Number(updates.attendanceThreshold);
    if (!(n >= 0 && n <= 100)) return { error: "Attendance threshold must be 0–100.", status: 400 };
    next.attendanceThreshold = n;
  }
  const { orgs } = await getOrgCollections();
  const set = Object.fromEntries(Object.entries(next).map(([k, v]) => [`education.${k}`, v]));
  set["education.updatedAt"] = new Date().toISOString();
  set["education.updatedByEmail"] = actorEmail;
  await orgs.updateOne({ _id: toObjectId(orgId) }, { $set: set });
  return { settings: await getEducationSettings(orgId) };
}
