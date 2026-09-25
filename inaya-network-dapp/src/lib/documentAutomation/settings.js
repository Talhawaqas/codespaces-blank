// src/lib/documentAutomation/settings.js
//
// Document Automation SOW §5/§6/§7/§10/§21/§22 -- per-organization
// configuration: numbering prefixes and fiscal-year policy, approval
// thresholds, default locale/page/margins/template per document type, the
// billing profile printed on documents (legal name, address, tax id, logo,
// brand color, default tax and payment terms) and the retention lock
// applied to finalized documents. Everything is validated and every change
// is written to the org's audit chain. Stored in ONE document per org
// (documentAutomationSettings) -- the org profile itself (industry-config)
// is not touched.

import { getOrgCollections, toObjectId, canManageFinance } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { SUPPORTED_LOCALES, normalizeLocale } from "./i18n.js";
import { DOCUMENT_TYPES } from "./templateSchema.js";
import { isSupportedCurrency } from "../currency.js";

export const DEFAULT_PREFIXES = {
  invoice: "INV", purchase_order: "PO", quotation: "QUO", receipt: "RCT", statement: "STMT",
  credit_note: "CN", debit_note: "DN", delivery_note: "DEL", business_report: "RPT",
};

// Approval is required at or above these amounts (document currency) by
// default. A finance manager can change them, or force approval for a type.
export const DEFAULT_APPROVAL_THRESHOLDS = {
  invoice: 10000, purchase_order: 10000, quotation: 25000, credit_note: 1000, debit_note: 1000,
  receipt: null, statement: null, delivery_note: null, business_report: null,
};

export const DEFAULT_SETTINGS = {
  numbering: { prefixes: DEFAULT_PREFIXES, fiscalYearReset: true, fiscalYearStartMonth: 1, padding: 6, separator: "-" },
  approval: { thresholds: DEFAULT_APPROVAL_THRESHOLDS, alwaysRequire: {}, staleAfterDays: 14 },
  defaults: {
    locale: "en-US", currency: "USD", pageSize: "A4", margins: { top: 50, right: 50, bottom: 50, left: 50 },
    templateByType: {}, roundingMode: "HALF_UP",
  },
  billingProfile: {
    legalName: null, address: null, email: null, phone: null, taxId: null, taxLabel: null, website: null,
    footerNote: null, brandColor: null, logo: null, defaultTaxPercent: 0, defaultPaymentTerms: null, defaultTerms: null,
  },
  retention: { finalizedRetentionDays: 2555, lockMode: "GOVERNANCE" },
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const MAX_LOGO_BYTES = 200 * 1024;

// ---- address helpers -------------------------------------------------
export function normalizeAddress(input, label = "address") {
  if (input === null || input === undefined || input === "") return { value: null };
  if (typeof input !== "object" || Array.isArray(input)) return { error: `${label} must be an object.` };
  const out = {};
  for (const key of ["line1", "line2", "city", "region", "postalCode", "country"]) {
    const v = input[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) return { error: `${label}.${key} is invalid.` };
    out[key] = v.trim();
  }
  for (const k of Object.keys(input)) if (!["line1", "line2", "city", "region", "postalCode", "country"].includes(k)) return { error: `${label}: unknown field "${k}".` };
  return { value: Object.keys(out).length ? out : null };
}

export function addressLines(addr) {
  if (!addr) return [];
  const cityLine = [addr.city, addr.region, addr.postalCode].filter(Boolean).join(", ");
  return [addr.line1, addr.line2, cityLine, addr.country].filter((l) => l && String(l).trim());
}

export function addressesDiffer(a, b) {
  return JSON.stringify(addressLines(a)) !== JSON.stringify(addressLines(b));
}

// ---- validation ------------------------------------------------------
function sniffLogo(base64, contentType) {
  let buf;
  try { buf = Buffer.from(base64, "base64"); } catch { return { error: "logo is not valid base64." }; }
  if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) return { error: `logo must be between 1 byte and ${MAX_LOGO_BYTES / 1024} KB.` };
  const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (contentType === "image/png" && !isPng) return { error: "logo bytes are not a PNG." };
  if (contentType === "image/jpeg" && !isJpg) return { error: "logo bytes are not a JPEG." };
  if (!["image/png", "image/jpeg"].includes(contentType)) return { error: "logo must be image/png or image/jpeg." };
  return { buf };
}

function str(v, max, label, errors) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) { errors.push(`${label} must be text up to ${max} characters.`); return undefined; }
  return v.trim();
}

/** Validates a partial settings update and returns the merged, normalized
 *  next settings, or { errors }. */
export function validateSettings(current, updates) {
  const errors = [];
  const next = JSON.parse(JSON.stringify(current));
  if (updates === null || typeof updates !== "object" || Array.isArray(updates)) return { errors: ["Settings must be an object."] };
  for (const k of Object.keys(updates)) if (!["numbering", "approval", "defaults", "billingProfile", "retention"].includes(k)) errors.push(`Unknown settings section "${k}".`);

  const n = updates.numbering;
  if (n) {
    if (n.prefixes) {
      for (const [type, prefix] of Object.entries(n.prefixes)) {
        if (!DOCUMENT_TYPES.includes(type)) { errors.push(`numbering.prefixes: unknown document type "${type}".`); continue; }
        if (typeof prefix !== "string" || !/^[A-Z0-9]{1,8}$/.test(prefix)) { errors.push(`numbering.prefixes.${type} must be 1-8 uppercase letters/digits.`); continue; }
        next.numbering.prefixes[type] = prefix;
      }
      const seen = new Map();
      for (const [type, prefix] of Object.entries(next.numbering.prefixes)) {
        if (seen.has(prefix)) errors.push(`numbering.prefixes: "${prefix}" is used by both ${seen.get(prefix)} and ${type}; prefixes must be unique so numbers can never collide.`);
        seen.set(prefix, type);
      }
    }
    if (n.fiscalYearReset !== undefined) { if (typeof n.fiscalYearReset !== "boolean") errors.push("numbering.fiscalYearReset must be true/false."); else next.numbering.fiscalYearReset = n.fiscalYearReset; }
    if (n.fiscalYearStartMonth !== undefined) { if (!Number.isInteger(n.fiscalYearStartMonth) || n.fiscalYearStartMonth < 1 || n.fiscalYearStartMonth > 12) errors.push("numbering.fiscalYearStartMonth must be 1-12."); else next.numbering.fiscalYearStartMonth = n.fiscalYearStartMonth; }
    if (n.padding !== undefined) { if (!Number.isInteger(n.padding) || n.padding < 3 || n.padding > 10) errors.push("numbering.padding must be 3-10."); else next.numbering.padding = n.padding; }
    if (n.separator !== undefined) { if (!["-", "/", "."].includes(n.separator)) errors.push('numbering.separator must be "-", "/" or ".".'); else next.numbering.separator = n.separator; }
  }

  const a = updates.approval;
  if (a) {
    if (a.thresholds) for (const [type, v] of Object.entries(a.thresholds)) {
      if (!DOCUMENT_TYPES.includes(type)) { errors.push(`approval.thresholds: unknown document type "${type}".`); continue; }
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e12)) { errors.push(`approval.thresholds.${type} must be a non-negative number or null.`); continue; }
      next.approval.thresholds[type] = v;
    }
    if (a.alwaysRequire) for (const [type, v] of Object.entries(a.alwaysRequire)) {
      if (!DOCUMENT_TYPES.includes(type) || typeof v !== "boolean") { errors.push(`approval.alwaysRequire.${type} must be true/false for a known document type.`); continue; }
      next.approval.alwaysRequire[type] = v;
    }
    if (a.staleAfterDays !== undefined) { if (!Number.isInteger(a.staleAfterDays) || a.staleAfterDays < 1 || a.staleAfterDays > 90) errors.push("approval.staleAfterDays must be 1-90."); else next.approval.staleAfterDays = a.staleAfterDays; }
  }

  const d = updates.defaults;
  if (d) {
    if (d.locale !== undefined) { const l = normalizeLocale(d.locale); if (!l) errors.push(`defaults.locale must be one of ${SUPPORTED_LOCALES.join(", ")}.`); else next.defaults.locale = l; }
    if (d.currency !== undefined) { if (!isSupportedCurrency(String(d.currency).toUpperCase())) errors.push("defaults.currency is not a supported currency."); else next.defaults.currency = String(d.currency).toUpperCase(); }
    if (d.pageSize !== undefined) { if (!["A4", "LETTER"].includes(d.pageSize)) errors.push('defaults.pageSize must be "A4" or "LETTER".'); else next.defaults.pageSize = d.pageSize; }
    if (d.roundingMode !== undefined) { if (!["HALF_UP", "HALF_EVEN", "DOWN", "UP"].includes(d.roundingMode)) errors.push("defaults.roundingMode is invalid."); else next.defaults.roundingMode = d.roundingMode; }
    if (d.margins) for (const side of ["top", "right", "bottom", "left"]) if (d.margins[side] !== undefined) { if (typeof d.margins[side] !== "number" || d.margins[side] < 20 || d.margins[side] > 120) errors.push(`defaults.margins.${side} must be 20-120.`); else next.defaults.margins[side] = d.margins[side]; }
    if (d.templateByType) for (const [type, id] of Object.entries(d.templateByType)) {
      if (!DOCUMENT_TYPES.includes(type) || (id !== null && (typeof id !== "string" || id.length > 80))) { errors.push(`defaults.templateByType.${type} is invalid.`); continue; }
      if (id === null) delete next.defaults.templateByType[type]; else next.defaults.templateByType[type] = id;
    }
  }

  const b = updates.billingProfile;
  if (b) {
    const bp = next.billingProfile;
    for (const [key, max] of [["legalName", 200], ["phone", 40], ["taxId", 64], ["taxLabel", 30], ["footerNote", 300], ["defaultPaymentTerms", 200], ["defaultTerms", 1500]]) {
      if (b[key] !== undefined) { const v = str(b[key], max, `billingProfile.${key}`, errors); if (v !== undefined) bp[key] = v; }
    }
    if (b.email !== undefined) { if (b.email === null || b.email === "") bp.email = null; else if (typeof b.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || b.email.length > 200) errors.push("billingProfile.email is not a valid email."); else bp.email = b.email.trim().toLowerCase(); }
    if (b.website !== undefined) { if (b.website === null || b.website === "") bp.website = null; else if (typeof b.website !== "string" || !/^https?:\/\/[^\s]{3,190}$/.test(b.website)) errors.push("billingProfile.website must be an http(s) URL."); else bp.website = b.website; }
    if (b.address !== undefined) { const r = normalizeAddress(b.address, "billingProfile.address"); if (r.error) errors.push(r.error); else bp.address = r.value; }
    if (b.brandColor !== undefined) { if (b.brandColor === null || b.brandColor === "") bp.brandColor = null; else if (!HEX_RE.test(b.brandColor)) errors.push("billingProfile.brandColor must be #RRGGBB."); else bp.brandColor = b.brandColor; }
    if (b.defaultTaxPercent !== undefined) { if (typeof b.defaultTaxPercent !== "number" || b.defaultTaxPercent < 0 || b.defaultTaxPercent > 100) errors.push("billingProfile.defaultTaxPercent must be 0-100."); else bp.defaultTaxPercent = b.defaultTaxPercent; }
    if (b.logo !== undefined) {
      if (b.logo === null) bp.logo = null;
      else if (typeof b.logo !== "object" || typeof b.logo.dataBase64 !== "string") errors.push("billingProfile.logo needs { contentType, dataBase64 }.");
      else { const r = sniffLogo(b.logo.dataBase64, b.logo.contentType); if (r.error) errors.push(`billingProfile.${r.error}`); else bp.logo = { contentType: b.logo.contentType, dataBase64: b.logo.dataBase64, bytes: r.buf.length }; }
    }
  }

  const r = updates.retention;
  if (r) {
    if (r.finalizedRetentionDays !== undefined) { if (!Number.isInteger(r.finalizedRetentionDays) || r.finalizedRetentionDays < 0 || r.finalizedRetentionDays > 36500) errors.push("retention.finalizedRetentionDays must be 0-36500."); else next.retention.finalizedRetentionDays = r.finalizedRetentionDays; }
    if (r.lockMode !== undefined) { if (!["GOVERNANCE", "COMPLIANCE"].includes(r.lockMode)) errors.push("retention.lockMode must be GOVERNANCE or COMPLIANCE."); else next.retention.lockMode = r.lockMode; }
  }

  return errors.length ? { errors } : { settings: next };
}

function mergeDefaults(stored) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!stored) return { ...base, version: 0 };
  return {
    numbering: { ...base.numbering, ...(stored.numbering || {}), prefixes: { ...base.numbering.prefixes, ...(stored.numbering?.prefixes || {}) } },
    approval: { ...base.approval, ...(stored.approval || {}), thresholds: { ...base.approval.thresholds, ...(stored.approval?.thresholds || {}) }, alwaysRequire: { ...(stored.approval?.alwaysRequire || {}) } },
    defaults: { ...base.defaults, ...(stored.defaults || {}), margins: { ...base.defaults.margins, ...(stored.defaults?.margins || {}) }, templateByType: { ...(stored.defaults?.templateByType || {}) } },
    billingProfile: { ...base.billingProfile, ...(stored.billingProfile || {}) },
    retention: { ...base.retention, ...(stored.retention || {}) },
    version: stored.version || 0,
  };
}

export async function getDocumentSettings(orgId) {
  const { documentAutomationSettings } = await getOrgCollections();
  const stored = await documentAutomationSettings.findOne({ orgId: toObjectId(orgId) });
  return mergeDefaults(stored);
}

/** Public view: never returns the logo bytes (only that one exists). */
export function redactSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  if (copy.billingProfile?.logo) copy.billingProfile.logo = { contentType: copy.billingProfile.logo.contentType, bytes: copy.billingProfile.logo.bytes, present: true };
  return copy;
}

export async function getBillingLogo(orgId) {
  const s = await getDocumentSettings(orgId);
  const logo = s.billingProfile.logo;
  if (!logo?.dataBase64) return null;
  return Buffer.from(logo.dataBase64, "base64");
}

export async function updateDocumentSettings({ orgId, updates, membership, actorEmail }) {
  if (!canManageFinance(membership)) return { error: "Only a Finance Manager or an owner/admin can change document settings.", status: 403 };
  const current = await getDocumentSettings(orgId);
  const result = validateSettings(current, updates);
  if (result.errors) return { error: result.errors.join(" "), status: 400 };
  const { documentAutomationSettings } = await getOrgCollections();
  const now = new Date().toISOString();
  const { version, ...toStore } = result.settings;
  // Optimistic concurrency: two simultaneous edits cannot silently overwrite each other.
  const filter = { orgId: toObjectId(orgId) };
  if (current.version > 0) filter.version = current.version;
  let saved;
  try {
    saved = await documentAutomationSettings.findOneAndUpdate(
      filter,
      { $set: { ...toStore, updatedAt: now, updatedByEmail: actorEmail }, $inc: { version: 1 }, $setOnInsert: { orgId: toObjectId(orgId), createdAt: now } },
      { upsert: current.version === 0, returnDocument: "after" }
    );
  } catch (err) {
    if (err?.code === 11000) return { error: "Settings changed while you were editing; reload and try again.", status: 409 };
    throw err;
  }
  if (!saved) return { error: "Settings changed while you were editing; reload and try again.", status: 409 };
  await logOrgActivity({
    orgId, recordType: "DOCUMENT_SETTINGS", recordId: toObjectId(orgId), actorEmail, action: "SETTINGS_UPDATED",
    previousState: String(current.version), newState: String(saved.version),
    metadata: { sections: Object.keys(updates), logoChanged: updates.billingProfile?.logo !== undefined },
  });
  return { settings: mergeDefaults(saved) };
}

// ---- approval policy --------------------------------------------------
/** ApprovalPolicy (SOW §37): does this document, at this amount, require a
 *  human approval before it can be finalized? */
export function approvalRequiredFor({ settings, documentType, amount }) {
  const forced = settings.approval.alwaysRequire?.[documentType];
  if (forced === true) return { required: true, reason: "This document type always requires approval (organization setting)." };
  if (forced === false) return { required: false, reason: "Approval is switched off for this document type (organization setting)." };
  const threshold = settings.approval.thresholds?.[documentType];
  if (threshold === null || threshold === undefined) return { required: false, reason: "No approval threshold applies to this document type." };
  if (typeof amount === "number" && amount >= threshold) return { required: true, reason: `The total (${amount}) is at or above the approval threshold (${threshold}).` };
  return { required: false, reason: `The total is below the approval threshold (${threshold}).` };
}
