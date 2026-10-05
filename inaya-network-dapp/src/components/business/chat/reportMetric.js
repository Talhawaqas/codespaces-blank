"use client";

// Client-side half of the privacy-safe metrics (OBS-001). Sends counts and bucketed latencies only; the server accepts nothing outside its fixed catalog
// (src/lib/metrics/metrics.js), so there is no way to attach a message, a name or an address here. Batched, best effort, never throws.

const queue = new Map(); let timer = null;

export function reportMetric(orgId, name, value = 1) {
  if (typeof window === "undefined" || !orgId) return;
  (queue.get(orgId) || queue.set(orgId, []).get(orgId)).push({ name, value });
  if (!timer) timer = setTimeout(flush, 5000);
}

function flush() {
  timer = null;
  for (const [orgId, events] of queue) {
    queue.delete(orgId);
    fetch(`/api/orgs/metrics/client?orgId=${encodeURIComponent(orgId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId, events: events.slice(0, 20) }), keepalive: true }).catch(() => {});
  }
}
