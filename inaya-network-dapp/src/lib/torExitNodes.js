// src/lib/torExitNodes.js
//
// Free, authoritative Tor exit-node detection -- the Tor Project itself
// publishes a live, plain-text bulk exit list (one IP per line) at
// https://check.torproject.org/torbulkexitlist, specifically intended for
// exactly this use case (services that want to identify Tor traffic).
// No vendor, no API key, no cost -- checked before proxycheck.io in
// fraudRisk.js's classifyIp() since it's a free, direct source for this
// one classification specifically.
//
// Cached in-memory with a periodic refresh rather than fetched per
// request -- the list is a few thousand lines and changes slowly enough
// that re-fetching on every classification would be wasteful and would
// make every assessment depend on that fetch succeeding.

const TOR_EXIT_LIST_URL = "https://check.torproject.org/torbulkexitlist";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let exitNodeSet = new Set();
let lastFetchedAt = 0;
let inFlightRefresh = null;

async function refresh() {
  try {
    const res = await fetch(TOR_EXIT_LIST_URL);
    if (!res.ok) {
      console.warn(`torExitNodes: fetch returned ${res.status} -- keeping previous list (${exitNodeSet.size} entries).`);
      return;
    }
    const text = await res.text();
    const ips = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    exitNodeSet = new Set(ips);
    lastFetchedAt = Date.now();
  } catch (err) {
    console.warn("torExitNodes: refresh failed (non-fatal, keeping previous list):", err.message);
  }
}

async function ensureFresh() {
  if (Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) return;
  // Coalesce concurrent callers into one in-flight fetch instead of each
  // triggering its own refresh.
  if (!inFlightRefresh) {
    inFlightRefresh = refresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;
}

/** Fails open to `false` (never Tor) on any fetch failure or before the first
 *  successful fetch -- classifyIp() falls through to proxycheck.io/UNKNOWN in that case,
 *  same fail-open philosophy as the rest of this layer. */
export async function isTorExitNode(ip) {
  if (!ip || ip === "unknown") return false;
  await ensureFresh();
  return exitNodeSet.has(ip);
}
