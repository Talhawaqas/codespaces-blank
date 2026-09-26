// src/lib/identity/common.js -- shared vocabulary for the identity integration layer.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export { fail, redact, bounded } from "../workflows/common.js";
export const nowIso = () => new Date().toISOString();
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hmacHex = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
export function safeEqualHex(a, b) {
  try { const x = Buffer.from(String(a), "hex"); const y = Buffer.from(String(b), "hex"); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); } catch { return false; }
}
export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const isEmail = (e) => /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/.test(String(e || ""));

export const PROVIDER_KINDS = ["entra", "ad", "hr", "psa", "rmm", "scim", "generic"];
export const SOURCES = ["ENTRA", "AD", "HR", "PSA", "RMM", "SCIM", "GENERIC", "INAYA_MANUAL_OVERRIDE", "INAYA_EXISTING", "TEMPORARY"];
export const SOURCE_OF_KIND = { entra: "ENTRA", ad: "AD", hr: "HR", psa: "PSA", rmm: "RMM", scim: "SCIM", generic: "GENERIC" };
export const EXTERNAL_SOURCES = ["ENTRA", "AD", "HR", "PSA", "RMM", "SCIM", "GENERIC"];

// grant kinds an external policy may produce. `owner` is deliberately absent: ownership is never granted from outside.
export const GRANT_KINDS = ["role", "department", "project", "financeRole", "hrRole", "supportRole", "storageRole", "escrowRole", "complianceRole"];
export const ROLE_VALUES = { role: ["member", "admin"], financeRole: ["staff", "manager"], hrRole: ["staff", "manager"], supportRole: ["agent", "manager"], storageRole: ["staff", "manager"], escrowRole: ["staff", "manager"], complianceRole: ["staff", "manager"] };
export const RANK = { staff: 1, agent: 1, member: 1, manager: 2, admin: 2 };

export const EVENT_TYPES = [
  "user.created", "user.updated", "user.disabled", "user.enabled", "user.department_changed", "user.role_changed", "user.group_changed", "user.deleted",
  "hr.joiner", "hr.mover", "hr.leaver", "hr.status_change", "psa.onboarding", "psa.offboarding", "security.restrict", "security.restore",
];
export const LIFECYCLE_TYPES = ["JOINER", "MOVER", "LEAVER", "STATUS_CHANGE", "RESTORE", "RECONCILE", "MANUAL_REVOKE", "MANUAL_GRANT", "INCIDENT_RESTRICT", "TEMP_EXPIRY", "REVIEW_REVOKE"];
export const REVOCATION_STATES = ["REVOCATION_PENDING", "REVOCATION_PARTIAL", "REVOCATION_COMPLETE", "REVOCATION_FAILED"];
export const RUN_STATES = ["PLANNED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "AWAITING_APPROVAL", "AWAITING_REVIEW", "SKIPPED", "STALE"];
export const FAILURE_CLASSES = ["TRANSIENT", "PERMANENT", "AUTHENTICATION", "AUTHORIZATION", "MAPPING", "VALIDATION", "PROVIDER", "RATE_LIMIT", "NETWORK"];
export const RETRYABLE = new Set(["TRANSIENT", "RATE_LIMIT", "NETWORK", "PROVIDER"]);

/** Error carrying a failure class (SOW §47). */
export class IdentityError extends Error {
  constructor(message, klass = "PERMANENT", extra = {}) { super(message); this.klass = klass; Object.assign(this, extra); }
}
export const classifyError = (err) => (err?.klass && FAILURE_CLASSES.includes(err.klass) ? err.klass : /timed? ?out|ECONN|fetch failed|ENOTFOUND|network/i.test(String(err?.message)) ? "NETWORK" : /429|rate limit/i.test(String(err?.message)) ? "RATE_LIMIT" : "TRANSIENT");

/** Event ordering (SOW §46). Returns true when `ev` is strictly newer than the watermark; on an exact tie a disabling event wins. */
export function isNewer(ev, mark, { disabling = false } = {}) {
  if (!mark || mark.time == null) return true;
  if (ev.time > mark.time) return true;
  if (ev.time < mark.time) return false;
  if (ev.sequence != null && mark.sequence != null) return ev.sequence > mark.sequence;
  return disabling; // same instant and no sequence: only a disable is allowed to win (an enable can never restore access on a tie)
}

export const clampInt = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
export const uniq = (a) => [...new Set(a)];
export const lower = (s) => String(s ?? "").trim().toLowerCase();
