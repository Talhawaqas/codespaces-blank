// src/lib/proxyCheck.js
//
// Replaces lib/ipQualityScore.js -- swapped after the configured IPQS
// account got auto-flagged by IPQS's own "duplicate free account" abuse
// detection and stopped returning usable data ("insufficient credits").
// proxycheck.io (https://proxycheck.io) covers the same need: VPN/proxy/
// Tor/hosting(datacenter) classification AND a 0-100 risk score in one
// call. Confirmed directly against the live v3 API while building this:
//   curl "https://proxycheck.io/v3/8.8.8.8?vpn=1&risk=1"
// returns { detections: { proxy, vpn, tor, hosting, compromised, risk,
// confidence, ... } } -- exactly the shape mapped below.
//
// PROXYCHECK_API_KEY in .env.local is OPTIONAL, unlike IPQS_API_KEY --
// proxycheck.io answers unauthenticated queries at 100/day per querying
// IP; a free registered key (no credit card) raises that to 1,000/day.
// Get one at https://proxycheck.io/dashboard/. Still fails open to
// UNKNOWN/neutral on any request failure, same as every other provider
// in this layer.

const PROXYCHECK_API_KEY = process.env.PROXYCHECK_API_KEY;
const PROXYCHECK_BASE_URL = "https://proxycheck.io/v3";

/** Returns { configured, classification, reputation } -- see ipQualityScore.js's
 *  old header comment for the shape this mirrors exactly (fraudRisk.js's
 *  classifyIp() doesn't need to change at all for this swap). `configured` is
 *  always true here (proxycheck.io works without a key), included only for
 *  interface parity with the provider this replaced. */
export async function lookupIp(ip) {
  if (!ip || ip === "unknown") {
    return { configured: true, classification: "UNKNOWN", reputation: null };
  }

  try {
    const keyParam = PROXYCHECK_API_KEY ? `&key=${encodeURIComponent(PROXYCHECK_API_KEY)}` : "";
    const url = `${PROXYCHECK_BASE_URL}/${encodeURIComponent(ip)}?vpn=1&asn=1&risk=1${keyParam}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`proxyCheck: API returned ${res.status} for lookup`);
      return { configured: true, classification: "UNKNOWN", reputation: null };
    }
    const data = await res.json();
    if (data.status !== "ok" && data.status !== "warning") {
      console.error("proxyCheck: API reported failure:", data.status, data.message || "");
      return { configured: true, classification: "UNKNOWN", reputation: null };
    }

    const entry = data[ip];
    const detections = entry?.detections;
    if (!detections) {
      return { configured: true, classification: "UNKNOWN", reputation: null };
    }

    let classification = "RESIDENTIAL_IP";
    if (detections.tor) classification = "TOR_DETECTED";
    else if (detections.vpn) classification = "VPN_DETECTED";
    else if (detections.hosting) classification = "DATACENTER_IP";
    else if (detections.proxy) classification = "PROXY_DETECTED";

    return {
      configured: true,
      classification,
      reputation: {
        fraudScore: typeof detections.risk === "number" ? detections.risk : 0,
        isKnownAbuser: !!detections.compromised,
      },
    };
  } catch (err) {
    console.error("proxyCheck: request failed:", err.message);
    return { configured: true, classification: "UNKNOWN", reputation: null };
  }
}
