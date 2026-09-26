// src/lib/bookkeeper/settings.js
//
// AI Bookkeeper SOW sections 19, 48, 51: administrator-configurable confidence thresholds, risk limits and categories. The 99% of the
// reference image is a DEFAULT, not a constant. Every change is validated, versioned and written to the audit trail.

import { toObjectId } from "../orgs.js";
import { getBookkeeperCollections, ensureBookkeeperIndexes } from "./db.js";
import { DEFAULT_SETTINGS, fail, nowIso, clamp01 } from "./common.js";
import { audit } from "./record.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep merge of stored settings over the defaults, so a new default reaches organizations that saved an older shape. */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export async function getSettings(orgId) {
  await ensureBookkeeperIndexes();
  const { bkSettings } = await getBookkeeperCollections();
  const row = await bkSettings.findOne({ orgId: toObjectId(orgId) });
  return { ...merge(DEFAULT_SETTINGS, row?.settings), version: row?.version || 0, updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || null };
}

export function validateSettings(patch) {
  const errors = [];
  const s = patch || {};
  if (s.thresholds !== undefined) {
    if (!isObj(s.thresholds)) errors.push("thresholds must be an object.");
    else for (const [k, v] of Object.entries(s.thresholds)) { if (!["extraction", "categorization", "match", "anomaly"].includes(k)) errors.push(`Unknown threshold ${k}.`); else if (!(v >= 0 && v <= 1)) errors.push(`thresholds.${k} must be between 0 and 1.`); }
  }
  if (s.autoProcess !== undefined) {
    if (!isObj(s.autoProcess)) errors.push("autoProcess must be an object.");
    else {
      const a = s.autoProcess;
      if (a.enabled !== undefined && typeof a.enabled !== "boolean") errors.push("autoProcess.enabled must be true or false.");
      for (const k of ["maxAmount", "requirePurchaseOrderAbove"]) if (a[k] !== undefined && !(Number.isFinite(a[k]) && a[k] >= 0)) errors.push(`autoProcess.${k} must be a non-negative number.`);
    }
  }
  if (s.highRiskAmount !== undefined && !(Number.isFinite(s.highRiskAmount) && s.highRiskAmount >= 0)) errors.push("highRiskAmount must be a non-negative number.");
  if (s.highRiskCategories !== undefined && !(Array.isArray(s.highRiskCategories) && s.highRiskCategories.every((c) => typeof c === "string" && c.length <= 80) && s.highRiskCategories.length <= 50)) errors.push("highRiskCategories must be a list of category names.");
  if (s.categories !== undefined && !(Array.isArray(s.categories) && s.categories.length >= 1 && s.categories.length <= 200 && s.categories.every((c) => typeof c === "string" && c.trim() && c.length <= 80))) errors.push("categories must be 1-200 names of at most 80 characters.");
  if (s.matching !== undefined) {
    if (!isObj(s.matching)) errors.push("matching must be an object.");
    else { const m = s.matching; if (m.dateWindowDays !== undefined && !(Number.isInteger(m.dateWindowDays) && m.dateWindowDays >= 0 && m.dateWindowDays <= 90)) errors.push("matching.dateWindowDays must be 0-90."); if (m.amountTolerance !== undefined && !(m.amountTolerance >= 0 && m.amountTolerance <= 100)) errors.push("matching.amountTolerance is invalid."); if (m.feeTolerancePct !== undefined && !(m.feeTolerancePct >= 0 && m.feeTolerancePct <= 0.2)) errors.push("matching.feeTolerancePct must be 0-0.2."); if (m.maxCombination !== undefined && !(Number.isInteger(m.maxCombination) && m.maxCombination >= 1 && m.maxCombination <= 10)) errors.push("matching.maxCombination must be 1-10."); }
  }
  if (s.learnFromReview !== undefined && typeof s.learnFromReview !== "boolean") errors.push("learnFromReview must be true or false.");
  if (s.retentionDays !== undefined && !(Number.isInteger(s.retentionDays) && s.retentionDays >= 30 && s.retentionDays <= 3650)) errors.push("retentionDays must be 30-3650.");
  const allowed = ["thresholds", "autoProcess", "highRiskAmount", "highRiskCategories", "matching", "categories", "learnFromReview", "notifications", "retentionDays"];
  for (const k of Object.keys(s)) if (!allowed.includes(k)) errors.push(`Unknown setting ${k}.`);
  return errors;
}

export async function updateSettings({ orgId, patch, actorEmail }) {
  const errors = validateSettings(patch);
  if (errors.length) return fail(errors[0], 400, { errors });
  await ensureBookkeeperIndexes();
  const { bkSettings } = await getBookkeeperCollections();
  const cur = await bkSettings.findOne({ orgId: toObjectId(orgId) });
  const next = merge(merge(DEFAULT_SETTINGS, cur?.settings), patch);
  const stored = { ...next }; // categories and lists replace, they do not merge
  if (patch.categories) stored.categories = [...new Set(patch.categories.map((c) => c.trim()))];
  if (patch.highRiskCategories) stored.highRiskCategories = [...new Set(patch.highRiskCategories)];
  const version = (cur?.version || 0) + 1;
  await bkSettings.updateOne({ orgId: toObjectId(orgId) }, { $set: { settings: stored, version, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  await audit({ orgId, action: "BOOKKEEPER_SETTINGS_CHANGED", actorEmail, metadata: { version, changed: Object.keys(patch) } });
  return { settings: await getSettings(orgId) };
}

export { clamp01 };
