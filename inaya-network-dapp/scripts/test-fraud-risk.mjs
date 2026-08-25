// scripts/test-fraud-risk.mjs
//
// Run with: node scripts/test-fraud-risk.mjs
//
// Standalone, framework-free test harness for src/lib/fraudRisk.js's pure
// decision functions (computeRiskScore/classifyRiskLevel/recommendAction).
// This package has no JS unit-test runner configured (Hardhat/chai in the
// root repo is Solidity-only) -- these are plain assertions against
// synthetic classification/reputation inputs, no network calls, no
// database, so they run in milliseconds and never depend on IPQualityScore
// or MongoDB being reachable.
//
// Covers the SOW's 10 named test scenarios (section 10) plus a direct,
// generic proof of the core principle: "VPN detection is a risk signal,
// not a verdict" -- connection-type classification alone, for EVERY
// classification, can never resolve to RESTRICT or TEMPORARILY_BLOCK.
//
// None of the assertions below touch the network or a database, but
// fraudRisk.js's import chain reaches lib/mongodb.js, which throws at
// MODULE LOAD time if MONGODB_URI isn't set. .env.local is loaded first,
// via a dynamic import() of fraudRisk.js rather than a static one -- ESM
// hoists ALL static imports to resolve before any of this file's own top-
// level statements run (including the dotenv.config() call below), so a
// static import here would still crash before the env ever loads.

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" }); // run from the package root (inaya-network-dapp/), same as every other script here

const { computeRiskScore, classifyRiskLevel, recommendAction, CLASSIFICATIONS } = await import("../src/lib/fraudRisk.js");

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"} — ${label} (got ${actual}, expected ${expected})`);
  ok ? passed++ : failed++;
}

function assessment({ classification, fraudScore = 0, isKnownAbuser = false }) {
  const reputation = { fraudScore, isKnownAbuser };
  const riskScore = computeRiskScore({ classification, reputation });
  const riskLevel = classifyRiskLevel(riskScore);
  const recommendedAction = recommendAction({ classification, reputation });
  return { riskScore, riskLevel, recommendedAction };
}

console.log("=== SOW section 10 scenarios ===\n");

// 1. Normal residential connection
check("1. Normal residential connection -> ALLOW", assessment({ classification: "RESIDENTIAL_IP", fraudScore: 5 }).recommendedAction, "ALLOW");

// 2. Mobile network -- collapses to RESIDENTIAL_IP (not VPN/proxy/datacenter), must not be penalized
check("2. Mobile network -> ALLOW", assessment({ classification: "RESIDENTIAL_IP", fraudScore: 10 }).recommendedAction, "ALLOW");

// 3. Known VPN, clean reputation
check("3. Known VPN alone -> MONITOR", assessment({ classification: "VPN_DETECTED", fraudScore: 15 }).recommendedAction, "MONITOR");

// 4. Proxy, clean reputation
check("4. Proxy alone -> MONITOR", assessment({ classification: "PROXY_DETECTED", fraudScore: 10 }).recommendedAction, "MONITOR");

// 5. Tor exit node, clean reputation
check("5. Tor exit node alone -> MONITOR", assessment({ classification: "TOR_DETECTED", fraudScore: 20 }).recommendedAction, "MONITOR");

// 6. Datacenter IP, clean reputation
check("6. Datacenter IP alone -> MONITOR", assessment({ classification: "DATACENTER_IP", fraudScore: 10 }).recommendedAction, "MONITOR");

// 7. Malicious/reputation-listed IP -- confirmed abuser, even on an otherwise-clean connection type
check("7. Confirmed malicious IP (residential) -> TEMPORARILY_BLOCK", assessment({ classification: "RESIDENTIAL_IP", fraudScore: 95, isKnownAbuser: true }).recommendedAction, "TEMPORARILY_BLOCK");

// 8. VPN + normal behavior (modeled as clean reputation -- Phase 1 doesn't
//    yet ingest behavioral signals, see the plan's Phase 2 scope)
check("8. VPN + normal behavior -> MONITOR", assessment({ classification: "VPN_DETECTED", fraudScore: 5 }).recommendedAction, "MONITOR");

// 9. VPN + suspicious behavior (modeled as elevated-but-not-confirmed reputation)
check("9. VPN + suspicious reputation -> VERIFY", assessment({ classification: "VPN_DETECTED", fraudScore: 80 }).recommendedAction, "VERIFY");

// 10. Multiple suspicious signals stacked (VPN + confirmed abuse)
check("10. VPN + confirmed abuse -> TEMPORARILY_BLOCK", assessment({ classification: "VPN_DETECTED", fraudScore: 95, isKnownAbuser: true }).recommendedAction, "TEMPORARILY_BLOCK");

console.log("\n=== Core principle: connection type alone is never a verdict ===\n");

// The generic, strongest form of the false-positive guarantee -- for every
// possible classification, at every clean/unknown reputation, the action
// can never reach RESTRICT or TEMPORARILY_BLOCK. Only a real reputation
// signal (checked separately above) can get there.
let guaranteeHeld = true;
for (const classification of CLASSIFICATIONS) {
  for (const fraudScore of [0, 25, 50, 74]) { // below ELEVATED_REPUTATION_THRESHOLD (75)
    const { recommendedAction } = assessment({ classification, fraudScore, isKnownAbuser: false });
    if (recommendedAction === "RESTRICT" || recommendedAction === "TEMPORARILY_BLOCK") {
      console.log(`FAIL — ${classification} @ fraudScore=${fraudScore} resolved to ${recommendedAction} with no confirmed reputation signal`);
      guaranteeHeld = false;
    }
  }
}
check("Legitimate VPN/proxy/Tor/datacenter users are never auto-blocked", guaranteeHeld, true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
