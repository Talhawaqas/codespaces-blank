// src/lib/workflows/common.js
//
// Shared helpers for the AI Business Operations Manager: error shape, secret
// redaction (SOW §32, §45), bounded JSON (SOW §50: no unbounded memory/record
// growth) and the audit vocabulary (SOW §46).

export const SYNTHETIC_OWNER = { role: "owner" };

export function fail(error, status = 400, extra = {}) { return { error, status, ...extra }; }

/** The SOW §46 lifecycle vocabulary. Each becomes a hash-chained audit entry. */
export const WORKFLOW_EVENTS = [
  "WORKFLOW_CREATED", "WORKFLOW_EDITED", "WORKFLOW_PUBLISHED", "WORKFLOW_ENABLED", "WORKFLOW_DISABLED", "WORKFLOW_DELETED",
  "WORKFLOW_ROLLED_BACK", "WORKFLOW_IMPORTED", "WORKFLOW_SHARED", "WORKFLOW_PERMISSION_CHANGED", "WORKFLOW_OWNER_CHANGED",
  "EXECUTION_STARTED", "EXECUTION_COMPLETED", "EXECUTION_FAILED", "EXECUTION_CANCELLED", "EXECUTION_EXPIRED", "EXECUTION_WAITING_APPROVAL",
  "NODE_EXECUTED", "NODE_FAILED", "AI_TOOL_CALLED", "DECISION_MADE", "APPROVAL_REQUESTED", "APPROVAL_RESOLVED",
  "ACTION_EXECUTED", "NOTIFICATION_SENT", "CREDENTIAL_CREATED", "CREDENTIAL_USED", "CREDENTIAL_REVOKED", "CREDENTIAL_ATTACHED",
  "EVALUATION_RUN", "REPORT_GENERATED", "SIMULATION_LINKED", "MEMORY_WRITTEN", "SCHEDULE_FIRED", "SCHEDULE_REFUSED",
];

const SECRET_KEY = /(secret|password|passwd|authorization|api[_-]?key|bearer|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|^token$|webhook(?:Url)?$)/i;

/** Deep copy with secret-looking keys masked. Never throws. */
export function redact(value, { secrets = [], depth = 0 } = {}) {
  if (depth > 12) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let s = value;
    for (const sec of secrets) if (sec && sec.length >= 6) s = s.split(sec).join("[REDACTED]");
    return s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]").replace(/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, "$1[REDACTED]");
  }
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redact(v, { secrets, depth: depth + 1 }));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v ? "[REDACTED]" : redact(v, { secrets, depth: depth + 1 });
  return out;
}

/** JSON-safe clone that is guaranteed under maxBytes (rows are trimmed, then
 *  the value is replaced by a stub carrying its size). */
export function bounded(value, maxBytes = 200_000) {
  let text;
  try { text = JSON.stringify(value === undefined ? null : value); } catch { return { _unserializable: true }; }
  if (text.length <= maxBytes) return JSON.parse(text);
  const clone = JSON.parse(text);
  if (Array.isArray(clone)) {
    const original = clone.length;
    while (clone.length > 1 && JSON.stringify(clone).length > maxBytes) clone.length = Math.floor(clone.length / 2);
    return { _truncated: true, originalRows: original, rows: clone };
  }
  if (clone && typeof clone === "object") {
    for (const [k, v] of Object.entries(clone)) if (Array.isArray(v) && v.length > 20) clone[k] = v.slice(0, 20);
    if (JSON.stringify(clone).length <= maxBytes) return { ...clone, _truncated: true };
  }
  return { _truncated: true, bytes: text.length };
}

/** A short summary of a value for the node inspector (counts/keys, not contents). */
export function summarize(value) {
  if (value === null || value === undefined) return { type: "empty" };
  if (Array.isArray(value)) return { type: "rows", count: value.length, fields: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 12) : [] };
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const counts = {};
    for (const k of keys.slice(0, 12)) if (Array.isArray(value[k])) counts[k] = value[k].length;
    return { type: "object", keys: keys.slice(0, 16), ...(Object.keys(counts).length ? { counts } : {}) };
  }
  return { type: typeof value, preview: String(value).slice(0, 120) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rejects if the promise takes longer than ms (the underlying work is not
 *  cancellable in Node, so callers also enforce their own AbortSignals). */
export function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms} ms.`), { code: "TIMEOUT" })), ms); }),
  ]).finally(() => clearTimeout(t));
}

export function backoffMs(attempt, base = 1000) { return Math.min(5 * 60 * 1000, base * 2 ** Math.max(0, attempt - 1)); }
