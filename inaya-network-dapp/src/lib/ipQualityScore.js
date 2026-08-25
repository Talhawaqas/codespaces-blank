// src/lib/ipQualityScore.js
//
// Thin client for IPQualityScore's IP reputation endpoint
// (https://ipqualityscore.com) -- one API covering VPN/proxy/Tor/
// datacenter classification AND abuse/fraud reputation scoring in a
// single call. Free tier (5,000 lookups/month) covers testnet.
//
// Requires IPQS_API_KEY in .env.local. Until it's set, lookupIp() no-ops
// and returns a neutral/unknown result rather than failing the request --
// identical fail-open pattern to sendEmail()'s RESEND_API_KEY handling in
// lib/email.js. Every caller in fraudRisk.js is written to degrade
// gracefully on this, never to throw or block whatever it was assessing.

const IPQS_API_KEY = process.env.IPQS_API_KEY;
const IPQS_BASE_URL = "https://ipqualityscore.com/api/json/ip";

/** Returns { configured, classification, reputation } where classification is
 *  one of VPN_DETECTED | PROXY_DETECTED | DATACENTER_IP | RESIDENTIAL_IP | UNKNOWN
 *  (never TOR_DETECTED -- that's torExitNodes.js's free, authoritative source,
 *  checked first in fraudRisk.js's classifyIp()) and reputation is
 *  { fraudScore: 0-100, isKnownAbuser: boolean } or null when not configured/failed. */
export async function lookupIp(ip) {
  if (!IPQS_API_KEY) {
    console.warn(`ipQualityScore: IPQS_API_KEY not set -- skipping real lookup for ${ip}. Set IPQS_API_KEY in .env.local to enable.`);
    return { configured: false, classification: "UNKNOWN", reputation: null };
  }
  if (!ip || ip === "unknown") {
    return { configured: true, classification: "UNKNOWN", reputation: null };
  }

  try {
    const url = `${IPQS_BASE_URL}/${IPQS_API_KEY}/${encodeURIComponent(ip)}?strictness=1`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`ipQualityScore: API returned ${res.status} for lookup`);
      return { configured: true, classification: "UNKNOWN", reputation: null };
    }
    const data = await res.json();
    if (data.success === false) {
      console.error("ipQualityScore: API reported failure:", data.message);
      return { configured: true, classification: "UNKNOWN", reputation: null };
    }

    let classification = "RESIDENTIAL_IP";
    if (data.vpn) classification = "VPN_DETECTED";
    else if (data.proxy) classification = "PROXY_DETECTED";
    else if (data.is_crawler || data.connection_type === "Data Center") classification = "DATACENTER_IP";

    return {
      configured: true,
      classification,
      reputation: {
        fraudScore: typeof data.fraud_score === "number" ? data.fraud_score : 0,
        isKnownAbuser: !!data.recent_abuse,
      },
    };
  } catch (err) {
    console.error("ipQualityScore: request failed:", err.message);
    return { configured: true, classification: "UNKNOWN", reputation: null };
  }
}
