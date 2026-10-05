// src/lib/metrics/metrics.js
//
// Privacy-safe structured metrics (Competitive Expansion SOW section 43, OBS-001). Counters only, from a FIXED catalog:
//   * a metric name must be in CATALOG and its label must be one of the values listed there; anything else is dropped, so free text (a message, a file name, an e-mail) can never become a label;
//   * values are numbers; latencies go into fixed buckets;
//   * storage is one counter document per (day, organization, name, label); there is no per-event record;
//   * the platform-wide export aggregates across organizations and carries no organization id, e-mail or label beyond the catalog.
// Recording never throws and never blocks the action it describes.
// Gauges (what is true now: gateways online, queue depth, control status, evidence freshness, failed jobs) are read from live state, not stored.

import { createHash, timingSafeEqual } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { hasAdminRole, canManageOrg } from "../orgGates.js";

export const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000];
const ANY = null; // no label
export const CATALOG = {
  // chat
  "chat.message_sent": { help: "Chat messages accepted by the server", labels: ANY }, "chat.send_failed": { help: "Chat sends refused", labels: ["STALE_EPOCH", "RECONCILE_REQUIRED", "DEVICE_REVOKED", "OTHER"] },
  "chat.security_event": { help: "Chat security events recorded", labels: ["DEVICE_REVOKED", "COMMIT_REJECTED", "MEMBER_REMOVED", "KEYPACKAGE_EXHAUSTED", "OTHER"] }, "chat.key_rotation": { help: "Conversation epoch changes (key rotations)", labels: ANY },
  "chat.decrypt_failure": { help: "Messages a client could not decrypt (client-reported)", labels: ANY, client: true }, "chat.reconnect": { help: "Client sync reconnects (client-reported)", labels: ANY, client: true },
  "chat.attachment_failure": { help: "Chat attachment failures (client-reported)", labels: ANY, client: true }, "chat.delivery_latency_ms": { help: "Send to visible latency in milliseconds (client-reported)", labels: ANY, client: true, histogram: true },
  "chat.unread_latency_ms": { help: "Unread count convergence in milliseconds (client-reported)", labels: ANY, client: true, histogram: true },
  // storage
  "storage.share_created": { help: "Share links created", labels: ["link", "member"] }, "storage.download_blocked": { help: "Downloads refused by a rule", labels: ["DLP", "SHARE_POLICY", "LOCK", "OTHER"] },
  "storage.dlp_decision": { help: "Data-loss decisions other than allow", labels: ["DENY", "REQUIRE_APPROVAL", "REQUIRE_STRONGER_AUTH", "LOG_ONLY", "QUARANTINE"] }, "storage.classification_job": { help: "Classification results applied or suggested", labels: ["applied", "suggested"] },
  "storage.preview_failure": { help: "Preview failures (client-reported)", labels: ANY, client: true },
  // gateway
  "gateway.heartbeat": { help: "Gateway heartbeats received", labels: ANY }, "gateway.transfer_completed": { help: "Gateway transfers completed", labels: ANY },
  // compliance and keys
  "compliance.snapshot": { help: "Compliance snapshots taken", labels: ANY }, "keys.operation": { help: "Key provider operations", labels: ["wrap_ok", "wrap_failed", "unwrap_ok", "unwrap_failed"] },
};
export const CLIENT_METRICS = Object.keys(CATALOG).filter((n) => CATALOG[n].client);
const bucketFor = (ms) => { for (const b of LATENCY_BUCKETS_MS) if (ms <= b) return String(b); return "inf"; };
const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);

async function col() { const { db } = await getOrgCollections(); const c = db.collection("metric_counters"); if (!col.done) { await Promise.all([c.createIndex({ day: 1, orgId: 1, name: 1, label: 1 }, { unique: true }), c.createIndex({ day: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } })]); col.done = true; } return c; }

/** Validates and normalizes a metric. Returns null when it must be dropped. */
export function normalize(name, { label = null, value = 1 } = {}) {
  const spec = CATALOG[name]; if (!spec) return null; let l = null;
  if (spec.labels) { if (label === null || label === undefined) l = null; else if (spec.labels.includes(String(label))) l = String(label); else return null; } else if (label) return null;
  const v = Number(value); if (!Number.isFinite(v) || v < 0 || v > 1e9) return null; if (spec.histogram) return { name, label: bucketFor(v), value: 1, observed: v }; return { name, label: l, value: spec.histogram ? 1 : v };
}
/** Fire-and-forget. Never throws. */
export function metric(name, opts = {}) { return record(name, opts).catch(() => {}); }
export async function record(name, { orgId = null, label = null, value = 1 } = {}) {
  const m = normalize(name, { label, value }); if (!m) return false; const c = await col(); const org = orgId ? toObjectId(orgId) : null;
  await c.updateOne({ day: dayOf(), orgId: org, name, label: m.label ?? "" }, { $inc: { n: m.value, ...(m.observed !== undefined ? { sum: m.observed } : {}) }, $setOnInsert: { expiresAt: new Date(Date.now() + 400 * 86400_000) } }, { upsert: true }); return true;
}

const canView = (m) => canManageOrg(m) || hasAdminRole(m, ["securityAdmin", "storageAdmin", "complianceAdmin", "dataGovernanceAdmin", "deviceAdmin", "integrationAdmin"], { read: true });
export async function orgMetrics({ orgId, membership, days = 7 }) {
  if (!canView(membership)) { const e = new Error("Only an administrator or auditor can read metrics."); e.status = 403; throw e; }
  const c = await col(); const d = Math.min(Math.max(Number(days) || 7, 1), 90); const since = dayOf(new Date(Date.now() - (d - 1) * 86400_000));
  const rows = await c.find({ orgId: toObjectId(orgId), day: { $gte: since } }).limit(5000).toArray(); const counters = {};
  for (const r of rows) { const e = (counters[r.name] ||= { help: CATALOG[r.name]?.help, total: 0, byLabel: {}, byDay: {} }); e.total += r.n; if (r.label) e.byLabel[r.label] = (e.byLabel[r.label] || 0) + r.n; e.byDay[r.day] = (e.byDay[r.day] || 0) + r.n; }
  return { days: d, counters, gauges: await gauges(orgId), notCollected: ["Delivery and unread latency, decryption failures, reconnects, attachment failures and preview failures are reported by clients; a name with no data means no client has reported it, not that it is zero."], privacy: "Counts and states only. No message text, file names, e-mail addresses or free-text labels are recorded." };
}
async function gauges(orgId) {
  const { db, orgDocuments } = await getOrgCollections(); const oid = toObjectId(orgId); const out = {}; const safe = async (k, fn) => { try { out[k] = await fn(); } catch { out[k] = null; } };
  await safe("gateway", async () => { const g = await db.collection("gateways").find({ orgId: oid, status: "active" }).project({ lastSeenAt: 1, health: 1 }).toArray(); return { gateways: g.length, online: g.filter((x) => x.lastSeenAt && Date.now() - new Date(x.lastSeenAt).getTime() <= 180_000).length, queueDepth: g.reduce((n, x) => n + (x.health?.queueDepth || 0), 0), maxLagSeconds: Math.max(0, ...g.map((x) => x.health?.lagSeconds || 0)), permissionSyncFailures: g.reduce((n, x) => n + (x.health?.aclFailures || 0), 0) }; });
  await safe("storage", async () => ({ objects: await orgDocuments.countDocuments({ orgId: oid, deletedAt: null }), activeShares: await db.collection("document_shares").countDocuments({ orgId: oid, revokedAt: null, expiresAt: { $gt: new Date().toISOString() } }).catch(() => null) }));
  await safe("compliance", async () => { const { summary } = await import("../compliance/implementation.js"); const s = await summary({ orgId, membership: { role: "owner" } }); const { verifyOrgEvidenceIntegrity } = await import("../evidence.js"); const a = await verifyOrgEvidenceIntegrity(orgId).catch(() => null); return { controlStatus: s.totals.byImplementation, evidence: s.totals.evidence, exceptionsExpired: s.totals.exceptionsExpired, auditChainValid: a ? (a.valid ?? a.ok ?? null) : null, assessed: s.totals.assessed }; });
  await safe("jobs", async () => { const r = await db.collection("job_runs").aggregate([{ $match: { orgId: oid, startedAt: { $gt: new Date(Date.now() - 7 * 86400_000).toISOString() } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(); return Object.fromEntries(r.map((x) => [x._id, x.n])); });
  return out;
}

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const pname = (n) => `inaya_${n.replace(/\./g, "_")}`;
/** Platform-wide Prometheus exposition: sums over all organizations, no organization id, no e-mail. */
export async function platformPrometheus({ days = 1 } = {}) {
  const c = await col(); const since = dayOf(new Date(Date.now() - (Math.max(1, days) - 1) * 86400_000)); const rows = await c.aggregate([{ $match: { day: { $gte: since } } }, { $group: { _id: { name: "$name", label: "$label" }, n: { $sum: "$n" } } }]).toArray(); const lines = [];
  const byName = {}; for (const r of rows) (byName[r._id.name] ||= []).push(r); for (const [name, spec] of Object.entries(CATALOG)) { lines.push(`# HELP ${pname(name)}_total ${esc(spec.help)}`, `# TYPE ${pname(name)}_total counter`); for (const r of byName[name] || []) lines.push(`${pname(name)}_total${r._id.label ? `{label="${esc(r._id.label)}"}` : ""} ${r.n}`); }
  const { db } = await getOrgCollections(); const jobs = await db.collection("job_runs").aggregate([{ $match: { startedAt: { $gt: new Date(Date.now() - 86400_000).toISOString() } } }, { $group: { _id: { name: "$name", status: "$status" }, n: { $sum: 1 } } }]).toArray(); lines.push("# HELP inaya_job_runs_24h Background job runs in the last 24 hours", "# TYPE inaya_job_runs_24h gauge"); for (const j of jobs) lines.push(`inaya_job_runs_24h{job="${esc(j._id.name)}",status="${esc(j._id.status)}"} ${j.n}`);
  const g = await db.collection("gateways").find({ status: "active" }).project({ lastSeenAt: 1, health: 1 }).limit(5000).toArray(); lines.push("# HELP inaya_gateways_active Registered active gateways", "# TYPE inaya_gateways_active gauge", `inaya_gateways_active ${g.length}`, "# HELP inaya_gateways_online Gateways that reported in the last three minutes", "# TYPE inaya_gateways_online gauge", `inaya_gateways_online ${g.filter((x) => x.lastSeenAt && Date.now() - new Date(x.lastSeenAt).getTime() <= 180_000).length}`);
  return lines.join("\n") + "\n";
}
export function metricsTokenOk(header, env = process.env) { const want = env.METRICS_TOKEN; if (!want || want.length < 16) return false; const got = String(header || "").replace(/^Bearer\s+/i, ""); const a = createHash("sha256").update(got).digest(), b = createHash("sha256").update(want).digest(); return timingSafeEqual(a, b); }
