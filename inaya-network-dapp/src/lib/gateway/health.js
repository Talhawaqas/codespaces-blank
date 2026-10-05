// src/lib/gateway/health.js -- tells administrators when a registered gateway has gone quiet. One alert per gateway per day; a gateway that has never connected is not "offline".
import { gwCols, ONLINE_WITHIN_MS } from "./gateway.js";

export async function alertOfflineGateways({ now = Date.now(), quietMs = 10 * 60_000 } = {}) {
  const c = await gwCols(); const cutoff = new Date(now - Math.max(quietMs, ONLINE_WITHIN_MS)).toISOString(); let alerted = 0;
  const rows = await c.gateways.find({ status: "active", revokedAt: null, lastSeenAt: { $ne: null, $lt: cutoff } }).limit(500).toArray(); const day = new Date(now).toISOString().slice(0, 10);
  for (const g of rows) {
    const r = await import("../notify/router.js").then((m) => m.notifyEvent({ orgId: g.orgId, event: "gateway.offline", audience: "admins", title: `Gateway "${g.label}" is offline`, body: `It last reported at ${g.lastSeenAt}.`, link: "/business?view=gateway", sourceId: String(g._id), dedupeKey: `gw-offline:${g._id}:${day}` })).catch(() => null);
    if (r?.results?.length) alerted++;
  }
  return { checked: rows.length, alerted };
}
