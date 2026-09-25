// src/lib/documentAutomation/metrics.js
//
// Document Automation SOW §35 -- observability. Numeric measurements only:
// durations, byte/page counts, failure and retry counters, queue latency.
// Deliberately NOTHING that could contain confidential content is ever
// recorded here (no document text, no keys, no secrets, no email addresses):
// dimensions are limited to short enumerated labels and opaque ids. Rows
// expire after 90 days via a TTL index.

import { getOrgCollections, toObjectId } from "../orgs.js";

export const METRICS = [
  "generation_ms", "render_ms", "storage_ms", "evidence_ms", "finalize_ms", "delivery_ms",
  "render_failure", "storage_failure", "evidence_failure", "delivery_failure", "template_failure",
  "retry", "document_bytes", "document_pages", "queue_latency_ms",
];

const SAFE_DIM_KEY = /^[a-zA-Z0-9_]{1,24}$/;
const SAFE_DIM_VALUE = /^[a-zA-Z0-9_.:-]{1,64}$/;

export async function recordMetric({ orgId, metric, value = 1, dimensions = {} }) {
  try {
    if (!METRICS.includes(metric)) return;
    const dims = {};
    for (const [k, v] of Object.entries(dimensions)) if (SAFE_DIM_KEY.test(k) && SAFE_DIM_VALUE.test(String(v))) dims[k] = String(v);
    const { documentMetrics } = await getOrgCollections();
    const now = new Date();
    await documentMetrics.insertOne({ orgId: toObjectId(orgId), metric, value: Number(value) || 0, dims, at: now.toISOString(), atDate: now });
  } catch (err) {
    console.error("recordMetric failed (non-fatal):", err.message);
  }
}

export async function timed(orgId, metric, fn, dimensions = {}) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    await recordMetric({ orgId, metric, value: Date.now() - t0, dimensions });
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export async function summarizeMetrics({ orgId, sinceIso }) {
  const { documentMetrics } = await getOrgCollections();
  const since = sinceIso || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = await documentMetrics.find({ orgId: toObjectId(orgId), at: { $gte: since } }).limit(20000).toArray();
  const byMetric = {};
  for (const r of rows) (byMetric[r.metric] ||= []).push(r.value);
  const out = {};
  for (const [metric, values] of Object.entries(byMetric)) {
    const sorted = [...values].sort((a, b) => a - b);
    out[metric] = { count: values.length, sum: values.reduce((a, b) => a + b, 0), avg: values.reduce((a, b) => a + b, 0) / values.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
  }
  return { since, metrics: out };
}
