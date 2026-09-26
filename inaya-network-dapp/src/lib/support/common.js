// src/lib/support/common.js
//
// Shared vocabulary for the Customer Portal & Customer Service platform: statuses and their allowed
// transitions (SOW §7.2), priorities, channels, text safety and small helpers. Nothing here touches the
// database.

import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export { fail, redact, bounded } from "../workflows/common.js";

export const STATUSES = ["NEW", "OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "ESCALATED", "SOLVED", "CLOSED", "CANCELLED"];
export const OPEN_STATUSES = ["NEW", "OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "ESCALATED"];
export const RESOLVED_STATUSES = ["SOLVED", "CLOSED", "CANCELLED"];
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const PRIORITY_RANK = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };
export const CHANNELS = ["PORTAL", "EMAIL", "API", "AI_CHAT", "AGENT"];
export const SLA_STATES = ["ON_TRACK", "AT_RISK", "BREACHED", "PAUSED", "COMPLETED"];
export const IDEA_STATES = ["SUBMITTED", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "SHIPPED", "DECLINED", "DUPLICATE"];
export const KB_STATES = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"];
export const KB_AUDIENCES = ["PUBLIC", "CUSTOMERS", "INTERNAL"];

/** Default lifecycle (SOW §7.2). A workspace may ADD transitions in settings; it can never remove the
 *  guarantees below (a closed/cancelled ticket only reopens through the explicit reopen path). */
export const DEFAULT_TRANSITIONS = {
  NEW: ["OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "ESCALATED", "SOLVED", "CANCELLED"],
  OPEN: ["IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "ESCALATED", "SOLVED", "CANCELLED"],
  IN_PROGRESS: ["OPEN", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "ESCALATED", "SOLVED", "CANCELLED"],
  WAITING_FOR_CUSTOMER: ["OPEN", "IN_PROGRESS", "ESCALATED", "SOLVED", "CANCELLED"],
  WAITING_FOR_INTERNAL: ["OPEN", "IN_PROGRESS", "ESCALATED", "SOLVED", "CANCELLED"],
  WAITING_FOR_THIRD_PARTY: ["OPEN", "IN_PROGRESS", "ESCALATED", "SOLVED", "CANCELLED"],
  ESCALATED: ["OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "SOLVED", "CANCELLED"],
  SOLVED: ["CLOSED", "OPEN"], // OPEN = reopen
  CLOSED: [], // reopen is a separate, policy-checked action
  CANCELLED: [],
};

export function allowedTransitions(from, settings) {
  const base = new Set(DEFAULT_TRANSITIONS[from] || []);
  for (const to of settings?.lifecycle?.extraTransitions?.[from] || []) if (STATUSES.includes(to) && from !== "CLOSED" && from !== "CANCELLED") base.add(to);
  return [...base];
}

export const isOpenStatus = (s) => OPEN_STATUSES.includes(s);

// ------------------------------------------------------------------ text safety
/** Messages are stored and shown as PLAIN TEXT. HTML is never stored or rendered, so there is nothing to
 *  execute in the agent console, the portal or an email. Inbound HTML is reduced to text here. */
export function toPlainText(input, max = 20000) {
  let s = String(input ?? "");
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  return s.trim().slice(0, max);
}

/** Drops quoted reply history ("On <date> ... wrote:" and leading > lines) so a thread stays readable. */
export function stripQuotedReply(text) {
  const lines = String(text || "").split("\n");
  const cut = lines.findIndex((l, i) => /^on .{5,120} wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*original message\s*-{2,}/i.test(l.trim()) || (/^from:\s/i.test(l.trim()) && /^sent:\s|^date:\s/i.test((lines[i + 1] || "").trim())));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^>+/.test(l.trim()));
  return kept.join("\n").trim();
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const isEmail = (e) => /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/.test(String(e || ""));

/** Pulls "Name <a@b.c>" apart. */
export function parseAddress(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = normEmail(m ? m[2] : s);
  return { email, name: (m ? m[1] : "").trim().slice(0, 120) || null };
}

// ------------------------------------------------------------------ tokens / ids
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function hmacHex(secret, data) { return createHmac("sha256", secret).update(data).digest("hex"); }
export function safeEqualHex(a, b) {
  try { const x = Buffer.from(String(a), "hex"); const y = Buffer.from(String(b), "hex"); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); } catch { return false; }
}

/** Similarity between two short texts (0..1): Jaccard over lowercase word sets, stop words removed.
 *  Deterministic and explainable; used for duplicate candidates and knowledge-gap grouping. */
const STOP = new Set("a an the and or of to in on for with is are was were be been it this that my our your we i you he she they at by from as but not no do does did can could would should please help need want hi hello thanks thank regards dear".split(" "));
export function tokens(text) { return new Set(String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))); }
export function similarity(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const clampInt = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
export const nowIso = () => new Date().toISOString();

/** Generic event vocabulary written to the audit chain and the events feed. */
export const SUPPORT_EVENTS = [
  "ticket.created", "ticket.updated", "ticket.assigned", "ticket.status_changed", "ticket.replied", "ticket.note_added", "ticket.priority_changed",
  "ticket.solved", "ticket.closed", "ticket.reopened", "ticket.merged", "ticket.related", "ticket.escalated", "ticket.sla_at_risk", "ticket.sla_breached",
  "ticket.triaged", "ticket.exported", "ticket.customer_replied", "ticket.attachment_added", "ticket.csat_received", "ticket.shared",
  "idea.created", "idea.status_changed", "knowledge_article.published", "ai.handoff", "customer.created", "customer.signed_in", "email.quarantined",
  "settings.changed", "queue.changed", "sla_policy.changed", "webhook.changed", "api_key.changed",
];
