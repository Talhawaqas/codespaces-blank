// scripts/simulate-security-nodes.js
//
// Multi-node testnet simulation (Security Layer SOW §20/§24's demo flow):
// 4 throwaway simulated "security nodes" independently report the SAME
// clearly-fake, non-real indicator, and this script shows the resulting
// reputation-weighted confidence at every step.
//
// Brand-new nodes start at the neutral DEFAULT_REPUTATION_BPS (5000) --
// by design, 4 neutral reporters alone CANNOT cross CONFIRM_THRESHOLD_BPS
// (7500), since the max independent-reporter bonus is capped at +1500.
// That's the reputation-weighting working correctly (see
// test/security.test.mjs's equivalent assertion), not a bug to work
// around here. To demonstrate the full "reaches CONFIRMED and lands
// on-chain" path from the SOW's demo flow, this script finishes with a
// real admin governance override (POST /api/admin/security/threats/:id/override)
// -- the same override path a human reviewer would use, and a legitimate
// part of the system (SOW §19's anti-abuse governance control), not a
// shortcut around the honest reputation math.
//
// Usage:
//   node scripts/simulate-security-nodes.js [--api-base http://localhost:3000]
// Requires ADMIN_DASHBOARD_PASSPHRASE in the environment to exercise the
// final governance-confirm + on-chain step; without it, the script still
// runs the 4-node report submission and prints the honest "not yet
// confirmed" result.

import { ethers } from "ethers";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const API_BASE = argValue("--api-base", process.env.INAYA_API_BASE_URL || "http://localhost:3000");
const CATEGORY = "phishing";
const TEST_INDICATOR = `sim-test-malicious-${Date.now()}.invalid`;

function buildSecurityReportMessage({ indicator, category, confidenceBps, evidenceHash, timestamp }) {
  const lines = [
    "Inaya Security Report",
    `indicator: ${String(indicator).trim().toLowerCase()}`,
    `category: ${String(category)}`,
    `confidenceBps: ${confidenceBps}`,
  ];
  if (evidenceHash) lines.push(`evidenceHash: ${evidenceHash}`);
  lines.push(`timestamp: ${timestamp}`);
  return lines.join("\n");
}

function computeThreatId(indicator) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(indicator).trim().toLowerCase()));
}

async function submitReport(wallet, indicator) {
  const timestamp = Date.now();
  const confidenceBps = 9000; // this node's own self-reported confidence -- the aggregate is computed server-side
  const message = buildSecurityReportMessage({ indicator, category: CATEGORY, confidenceBps, evidenceHash: null, timestamp });
  const signature = await wallet.signMessage(message);

  const res = await fetch(`${API_BASE}/api/security/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeAddress: wallet.address, indicator, category: CATEGORY, confidenceBps, evidenceHash: null, message, signature, timestamp }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Report failed (${res.status})`);
  return body;
}

async function main() {
  console.log(`Simulating 4 independent security nodes reporting: ${TEST_INDICATOR}`);
  console.log(`API base: ${API_BASE}\n`);

  const nodes = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());

  for (let i = 0; i < nodes.length; i++) {
    const result = await submitReport(nodes[i], TEST_INDICATOR);
    console.log(
      `Node ${i + 1} (${nodes[i].address.slice(0, 10)}...) reported -> ` +
        `confidence ${(result.confidenceBps / 100).toFixed(1)}%, ` +
        `${result.contributingNodes.length} independent reporter(s), ` +
        `status: ${result.confirmed ? "CONFIRMED" : "collecting"}`
    );
  }

  const threatId = computeThreatId(TEST_INDICATOR);
  const finalCheck = await (await fetch(`${API_BASE}/api/security/threat?indicator=${encodeURIComponent(TEST_INDICATOR)}`)).json();
  console.log(`\nAfter 4 independent (neutral-reputation) reports: status=${finalCheck.statusLabel}, confidence=${(finalCheck.confidenceBps / 100).toFixed(1)}%`);
  console.log("Expected: still below the 75% confirmation threshold -- 4 brand-new nodes' reputation-weighted average alone isn't enough, by design.\n");

  const adminPassphrase = process.env.ADMIN_DASHBOARD_PASSPHRASE;
  if (!adminPassphrase) {
    console.log("Set ADMIN_DASHBOARD_PASSPHRASE to also exercise the governance-confirm + real on-chain confirmThreat step.");
    return;
  }

  console.log("Exercising the admin governance override (the human-reviewer confirm path)...");
  const loginRes = await fetch(`${API_BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: adminPassphrase }),
  });
  if (!loginRes.ok) throw new Error("Admin login failed -- check ADMIN_DASHBOARD_PASSPHRASE.");
  const cookie = loginRes.headers.get("set-cookie");

  const overrideRes = await fetch(`${API_BASE}/api/admin/security/threats/${threatId}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ status: 1, confidenceBps: 9500 }), // 1 = Confirmed
  });
  const overrideBody = await overrideRes.json();
  if (!overrideRes.ok) throw new Error(overrideBody.error || "Override failed.");

  console.log(`Admin override applied: status=CONFIRMED, confidenceBps=9500`);
  console.log(
    overrideBody.onChain?.success
      ? `On-chain confirmThreat succeeded: tx ${overrideBody.onChain.txHash}`
      : `On-chain call skipped/failed (${overrideBody.onChain?.attempted ? "attempted but failed" : "contracts likely not deployed yet"}) -- see server logs.`
  );

  const finalState = await (await fetch(`${API_BASE}/api/security/threat?indicator=${encodeURIComponent(TEST_INDICATOR)}`)).json();
  console.log(`\nFinal state: status=${finalState.statusLabel}, confidence=${(finalState.confidenceBps / 100).toFixed(1)}%, onChainTxHash=${finalState.onChainTxHash || "none"}`);
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  process.exitCode = 1;
});
