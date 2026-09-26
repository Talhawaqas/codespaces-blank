// src/lib/identity/normalize.js
//
// SOW §22, §23, §27: the ONE canonical identity event, and adapters that turn each source's payload into it, so the
// engine never hardcodes a vendor. Also the webhook verifier: nothing is processed until the signature, timestamp and
// schema check out.
//
// Canonical event:
//   { eventId, type, tenantId, occurredAt, sequence?, version, correlationId?, subject: { externalId, upn?, email?, employeeId?,
//     displayName?, department?, jobTitle?, managerExternalId?, groups?[], accountEnabled?, employmentStatus?, employeeType?,
//     contractEndDate?, attributes? } }
// Signature: X-Inaya-Signature = hex HMAC-SHA256(signingSecret, `${X-Inaya-Timestamp}.${rawBody}`), timestamp within 5 minutes.

import { hmacHex, safeEqualHex, EVENT_TYPES, normEmail, isEmail, lower } from "./common.js";

export const MAX_BODY_BYTES = 256 * 1024;
export const TOLERANCE_S = 300;

export const signPayload = (secret, timestamp, rawBody) => hmacHex(secret, `${timestamp}.${rawBody}`);

/** Returns { ok: true } or { ok: false, status, reason }. Never reveals which check failed beyond a generic class. */
export function verifySignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, status: 503, reason: "not_configured" };
  if (rawBody.length > MAX_BODY_BYTES) return { ok: false, status: 413, reason: "too_large" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return { ok: false, status: 401, reason: "bad_timestamp" };
  const sig = String(signature || "").replace(/^v1=/, "");
  if (!safeEqualHex(sig, signPayload(secret, String(timestamp), rawBody))) return { ok: false, status: 401, reason: "bad_signature" };
  return { ok: true };
}

const str = (v, max = 200) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));
const bool = (v) => (v === undefined || v === null ? undefined : v === true || v === "true" || v === 1 || v === "1");
const isoOrNull = (v) => { if (v === undefined || v === null || v === "") return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : NaN; };
const nameOf = (g) => (typeof g === "string" ? g : g?.displayName || g?.name || g?.id || "");

function cleanSubject(s) {
  const out = {
    externalId: str(s.externalId, 128), upn: str(s.upn, 200), email: s.email ? normEmail(s.email) : undefined, employeeId: str(s.employeeId, 64),
    displayName: str(s.displayName, 160), department: str(s.department, 120), jobTitle: str(s.jobTitle, 120), managerExternalId: str(s.managerExternalId, 128),
    accountEnabled: bool(s.accountEnabled), employmentStatus: str(s.employmentStatus, 30)?.toUpperCase(), employeeType: str(s.employeeType, 30)?.toLowerCase(),
    contractEndDate: isoOrNull(s.contractEndDate),
  };
  if (Array.isArray(s.groups)) out.groups = [...new Set(s.groups.map((g) => str(nameOf(g), 200)).filter(Boolean))].slice(0, 200);
  if (s.attributes && typeof s.attributes === "object" && !Array.isArray(s.attributes)) out.attributes = Object.fromEntries(Object.entries(s.attributes).slice(0, 30).map(([k, v]) => [String(k).slice(0, 60), typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200)]));
  return out;
}

/** Validates a canonical event. Returns { event } or { error }. */
export function validateCanonical(b, { now = Date.now() } = {}) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "The event must be a JSON object." };
  const eventId = str(b.eventId, 128);
  if (!eventId || !/^[A-Za-z0-9._:@-]{6,128}$/.test(eventId)) return { error: "eventId is required (6-128 characters: letters, numbers . _ : @ -)." };
  if (!EVENT_TYPES.includes(b.type)) return { error: `type must be one of ${EVENT_TYPES.join(", ")}.` };
  const tenantId = str(b.tenantId, 120);
  if (!tenantId) return { error: "tenantId is required." };
  const t = Date.parse(b.occurredAt);
  if (!Number.isFinite(t)) return { error: "occurredAt must be an ISO timestamp." };
  if (t > now + 24 * 3600 * 1000) return { error: "occurredAt is too far in the future." };
  if (b.sequence !== undefined && b.sequence !== null && !(Number.isInteger(b.sequence) && b.sequence >= 0)) return { error: "sequence must be a non-negative integer." };
  if (!b.subject || typeof b.subject !== "object") return { error: "subject is required." };
  const subject = cleanSubject(b.subject);
  if (!subject.externalId) return { error: "subject.externalId (the provider's immutable object id) is required." };
  if (subject.email && !isEmail(subject.email)) return { error: "subject.email is not a valid address." };
  if (Number.isNaN(subject.contractEndDate)) return { error: "subject.contractEndDate must be a date." };
  // an explicit disable/enable/delete type fixes the account state so a sloppy payload cannot contradict it
  if (b.type === "user.disabled" || b.type === "hr.leaver" || b.type === "psa.offboarding") subject.accountEnabled = false;
  if (b.type === "user.deleted") { subject.accountEnabled = false; subject.employmentStatus = subject.employmentStatus || "TERMINATED"; }
  if (b.type === "user.enabled") subject.accountEnabled = true;
  return { event: { eventId, type: b.type, tenantId, occurredAt: new Date(t).toISOString(), time: t, sequence: b.sequence ?? null, version: Number(b.version) || 1, correlationId: str(b.correlationId, 128) || null, subject } };
}

// ------------------------------------------------------------------ source adapters
const ENTRA_TYPE = { created: "user.created", updated: "user.updated", deleted: "user.deleted" };

function fromEntra(b) {
  if (b?.subject && b?.type) return b; // already canonical
  const u = b.resourceData || b.user || b.data || b;
  const type = b.type || (u.accountEnabled === false ? "user.disabled" : ENTRA_TYPE[b.changeType] || "user.updated");
  return { eventId: b.eventId || b.id || b.subscriptionId && `${b.subscriptionId}:${b.resourceData?.id}:${b.subscriptionExpirationDateTime}`, type, tenantId: b.tenantId || u.tenantId, occurredAt: b.occurredAt || b.eventTime || b.createdDateTime || new Date().toISOString(), sequence: b.sequence,
    correlationId: b.correlationId, subject: { externalId: u.id || u.objectId, upn: u.userPrincipalName, email: u.mail || u.userPrincipalName, employeeId: u.employeeId, displayName: u.displayName, department: u.department, jobTitle: u.jobTitle, managerExternalId: u.manager?.id, groups: u.groups || u.memberOf, accountEnabled: u.accountEnabled, employeeType: u.employeeType, contractEndDate: u.employeeLeaveDateTime } };
}

function fromAd(b) {
  if (b?.subject && b?.type) return b;
  const a = b.ad || b.user || b;
  const uac = Number(a.userAccountControl);
  const enabled = a.accountEnabled ?? (Number.isFinite(uac) ? (uac & 2) === 0 : undefined);
  const groups = (a.memberOf || a.groups || []).map((g) => String(g).replace(/^CN=([^,]+),.*$/i, "$1"));
  return { eventId: b.eventId, type: b.type || (enabled === false ? "user.disabled" : "user.updated"), tenantId: b.tenantId || b.domainSid || b.forest, occurredAt: b.occurredAt || a.whenChanged || new Date().toISOString(), sequence: b.sequence ?? (a.uSNChanged !== undefined ? Number(a.uSNChanged) : undefined), correlationId: b.correlationId,
    subject: { externalId: a.objectGUID || a.objectSid || a.externalId, upn: a.userPrincipalName, email: a.mail || a.userPrincipalName, employeeId: a.employeeID || a.employeeId, displayName: a.displayName, department: a.department, jobTitle: a.title || a.jobTitle, managerExternalId: a.manager, groups, accountEnabled: enabled, employeeType: a.employeeType } };
}

const HR_TYPE = { hire: "hr.joiner", joiner: "hr.joiner", rehire: "hr.joiner", transfer: "hr.mover", promotion: "hr.mover", mover: "hr.mover", termination: "hr.leaver", terminate: "hr.leaver", leaver: "hr.leaver", resignation: "hr.leaver", leave: "hr.status_change", status_change: "hr.status_change" };
function fromHr(b) {
  if (b?.subject && b?.type) return b;
  const e = b.employee || b.worker || b.subject || {};
  const type = HR_TYPE[String(b.eventType || b.event || b.type || "").toLowerCase()] || b.type;
  return { eventId: b.eventId || b.id, type, tenantId: b.tenantId || b.companyId, occurredAt: b.effectiveDate || b.occurredAt || new Date().toISOString(), sequence: b.sequence, correlationId: b.correlationId,
    subject: { externalId: e.externalId || e.workerId || e.id || e.employeeId, upn: e.upn, email: e.workEmail || e.email, employeeId: e.employeeId || e.workerId, displayName: e.name || e.displayName, department: e.department, jobTitle: e.jobTitle || e.position, managerExternalId: e.managerId, groups: e.groups, accountEnabled: e.accountEnabled, employmentStatus: e.employmentStatus || (type === "hr.leaver" ? "TERMINATED" : undefined), employeeType: e.workerType || e.employeeType, contractEndDate: e.endDate } };
}

function fromPsa(b) {
  if (b?.subject && b?.type) return b;
  const t = b.ticket || {}; const u = b.user || b.subject || {};
  const kind = String(t.type || b.workflow || b.type || "").toLowerCase();
  return { eventId: b.eventId || (t.id ? `psa:${t.id}:${kind}` : undefined), type: /off/.test(kind) ? "psa.offboarding" : /on/.test(kind) ? "psa.onboarding" : b.type, tenantId: b.tenantId || t.companyId, occurredAt: b.occurredAt || t.updatedAt || new Date().toISOString(), sequence: b.sequence, correlationId: b.correlationId || (t.id ? `ticket:${t.id}` : undefined),
    subject: { externalId: u.externalId || u.id, upn: u.upn, email: u.email, employeeId: u.employeeId, displayName: u.name || u.displayName, department: u.department, jobTitle: u.jobTitle, groups: u.groups, accountEnabled: /off/.test(kind) ? false : u.accountEnabled, employeeType: u.employeeType } };
}

const ADAPTERS = { entra: fromEntra, ad: fromAd, rmm: fromAd, hr: fromHr, psa: fromPsa, scim: (b) => b, generic: (b) => b };

/** Raw provider payload -> canonical event, validated. */
export function normalizeEvent(kind, body, opts) {
  let mapped;
  try { mapped = (ADAPTERS[kind] || ADAPTERS.generic)(body); } catch { return { error: "The payload could not be read." }; }
  return validateCanonical(mapped, opts);
}

export const lifecycleClassOfType = (type) => ({ "user.created": "JOINER", "hr.joiner": "JOINER", "psa.onboarding": "JOINER", "user.disabled": "LEAVER", "user.deleted": "LEAVER", "hr.leaver": "LEAVER", "psa.offboarding": "LEAVER", "user.enabled": "RESTORE", "security.restrict": "INCIDENT_RESTRICT", "security.restore": "RESTORE", "hr.mover": "MOVER", "user.department_changed": "MOVER", "user.role_changed": "MOVER", "user.group_changed": "MOVER", "user.updated": "MOVER", "hr.status_change": "STATUS_CHANGE" })[type] || "STATUS_CHANGE";
export { lower };
