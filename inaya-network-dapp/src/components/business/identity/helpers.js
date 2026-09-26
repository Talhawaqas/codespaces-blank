"use client";

import { api } from "../nas/ui";

export const BASE = "/api/integrations/identity";
export const q = (orgId, extra = "") => `orgId=${encodeURIComponent(orgId)}${extra}`;
export const get = (orgId, path, extra = "") => api(`${BASE}/${path}?${q(orgId, extra)}`);
export const send = (orgId, path, body = {}, method = "POST") => api(`${BASE}/${path}?${q(orgId)}`, { method, body: JSON.stringify({ orgId, ...body }) });

/** Maps identity states onto the shared Pill tones. */
export const TONE = {
  COMPLETED: "OK", REVOCATION_COMPLETE: "OK", VERIFIED: "OK", ACTIVE: "OK", DELIVERED: "OK", PROCESSED: "OK", MATCH: "OK", APPROVED: "OK", RESOLVED: "OK", CLOSED: "OK",
  PARTIAL: "WARNING", REVOCATION_PARTIAL: "WARNING", REVOCATION_PENDING: "WARNING", AWAITING_APPROVAL: "WARNING", PENDING: "WARNING", PENDING_APPROVAL: "WARNING", DRIFT: "WARNING", OPEN: "WARNING", RUNNING: "WARNING", QUEUED: "WARNING", STALE: "WARNING", UNRESOLVED: "WARNING",
  FAILED: "CRITICAL", REVOCATION_FAILED: "CRITICAL", CONFLICT: "CRITICAL", DEAD: "CRITICAL", REJECTED: "CRITICAL", DISABLED: "CRITICAL", critical: "CRITICAL", high: "CRITICAL", medium: "WARNING",
};
export const tone = (v) => TONE[v] || v;
export const SOURCE_TONE = { "INAYA MANUAL OVERRIDE": "WARNING", TEMPORARY: "WARNING" };

export const downloadText = (name, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};
