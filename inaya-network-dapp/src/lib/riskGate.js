// src/lib/riskGate.js
//
// Phase 2 -- the enforcement half of the Fraud & Abuse Protection Layer.
// Phase 1 (lib/fraudRisk.js) only ever computed and recorded an
// assessment; this is what actually turns a RESTRICT/TEMPORARILY_BLOCK
// recommendation into a rejected request at a real call site.
//
// Deliberately narrow: only RESTRICT and TEMPORARILY_BLOCK ever reject a
// request. ALLOW/MONITOR/VERIFY always pass through -- per fraudRisk.js's
// own guarantee, those three can only be reached by connection-type
// classification (VPN/proxy/Tor/datacenter) alone, and the SOW's core
// principle is that connection type alone is a signal, never a verdict.
// Only a CONFIRMED reputation signal (a real known-abuser flag, or a very
// high fraud score) can reach the two levels this actually blocks on.
//
// Never throws -- assessRisk() itself already fails open (see its own
// comment), so a provider outage here degrades to "allowed" rather than
// breaking whatever called it.
export async function enforceRiskGate({ req, identityId, surface }) {
  const assessment = await assessRiskSafely({ req, identityId, surface });
  const blocked = assessment.recommendedAction === "RESTRICT" || assessment.recommendedAction === "TEMPORARILY_BLOCK";
  return { allowed: !blocked, assessment };
}

async function assessRiskSafely(args) {
  try {
    const { assessRisk } = await import("./fraudRisk.js");
    return await assessRisk(args);
  } catch (err) {
    console.error("enforceRiskGate: assessRisk failed (failing open):", err.message);
    return { recommendedAction: "ALLOW" };
  }
}

/** The generic rejection response body/status for every gated route -- one
 *  wording, one status code, so a blocked request looks the same everywhere
 *  instead of leaking route-specific detail about why. */
export const RISK_GATE_REJECTION = {
  error: "This request couldn't be completed from your current network. If you believe this is a mistake, please try again later or contact support.",
  status: 403,
};
