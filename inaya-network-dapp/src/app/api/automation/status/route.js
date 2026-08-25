// app/api/automation/status/route.js
//
// GET /api/automation/status — public, no auth. Reads on-chain state
// directly from the 3 deployed Oracle & Automation Layer contracts (same
// read-only ethers.JsonRpcProvider pattern as lib/metadata-auth.js's
// verifyOnChainFileOwner) -- no database involved, the chain itself is
// the source of truth for this page. Real deployed addresses:
//   NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS / NEXT_PUBLIC_ORACLE_ADAPTER_ADDRESS
//   / NEXT_PUBLIC_AUTOMATION_REGISTRY_ADDRESS

import { NextResponse } from "next/server";
import { ethers } from "ethers";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const ORACLE_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS;
const ORACLE_ADAPTER_ADDRESS = process.env.NEXT_PUBLIC_ORACLE_ADAPTER_ADDRESS;
const AUTOMATION_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_AUTOMATION_REGISTRY_ADDRESS;

const REGISTRY_ABI = [
  "function getSourceCount() view returns (uint256)",
  "function sourceIds(uint256) view returns (bytes32)",
  "function sources(bytes32) view returns (string dataType, address submitter, bool active, uint256 updateFrequency, bool exists)",
];
const ADAPTER_ABI = [
  "function getLatestData(bytes32) view returns (uint256 value, uint256 reportedTimestamp, uint256 submittedAt)",
  "function isStale(bytes32) view returns (bool)",
  "function maxStalenessSeconds() view returns (uint256)",
];
const AUTOMATION_REGISTRY_ABI = [
  "function getTaskCount() view returns (uint256)",
  "function taskIds(uint256) view returns (bytes32)",
  "function tasks(bytes32) view returns (address targetContract, bytes4 functionSelector, string conditionDescription, bool active, uint256 lastExecution, uint256 nextEligible, uint256 consecutiveFailures, bool exists)",
];

export const dynamic = "force-dynamic";

export async function GET() {
  if (!ORACLE_REGISTRY_ADDRESS || !ORACLE_ADAPTER_ADDRESS || !AUTOMATION_REGISTRY_ADDRESS) {
    return NextResponse.json({ error: "Oracle & Automation Layer isn't deployed yet." }, { status: 503 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const registry = new ethers.Contract(ORACLE_REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    const adapter = new ethers.Contract(ORACLE_ADAPTER_ADDRESS, ADAPTER_ABI, provider);
    const automationRegistry = new ethers.Contract(AUTOMATION_REGISTRY_ADDRESS, AUTOMATION_REGISTRY_ABI, provider);

    const [sourceCount, taskCount, maxStaleness] = await Promise.all([
      registry.getSourceCount(),
      automationRegistry.getTaskCount(),
      adapter.maxStalenessSeconds(),
    ]);

    const sources = [];
    for (let i = 0; i < sourceCount; i++) {
      const id = await registry.sourceIds(i);
      const s = await registry.sources(id);
      const [value, reportedTimestamp, submittedAt] = await adapter.getLatestData(id);
      const stale = await adapter.isStale(id);
      sources.push({
        id,
        dataType: s.dataType,
        submitter: s.submitter,
        active: s.active,
        updateFrequencySeconds: Number(s.updateFrequency),
        latestValue: value.toString(),
        reportedTimestamp: reportedTimestamp > 0n ? new Date(Number(reportedTimestamp) * 1000).toISOString() : null,
        lastUpdate: submittedAt > 0n ? new Date(Number(submittedAt) * 1000).toISOString() : null,
        stale,
      });
    }

    const tasks = [];
    for (let i = 0; i < taskCount; i++) {
      const id = await automationRegistry.taskIds(i);
      const t = await automationRegistry.tasks(id);
      tasks.push({
        id,
        targetContract: t.targetContract,
        functionSelector: t.functionSelector,
        conditionDescription: t.conditionDescription,
        active: t.active,
        lastExecution: t.lastExecution > 0n ? new Date(Number(t.lastExecution) * 1000).toISOString() : null,
        nextEligible: t.nextEligible > 0n ? new Date(Number(t.nextEligible) * 1000).toISOString() : null,
        consecutiveFailures: Number(t.consecutiveFailures),
      });
    }

    return NextResponse.json({
      network: "BSC Testnet",
      contracts: {
        oracleRegistry: ORACLE_REGISTRY_ADDRESS,
        oracleAdapter: ORACLE_ADAPTER_ADDRESS,
        automationRegistry: AUTOMATION_REGISTRY_ADDRESS,
      },
      maxStalenessSeconds: Number(maxStaleness),
      sources,
      tasks,
    });
  } catch (err) {
    console.error("automation/status GET failed:", err);
    return NextResponse.json({ error: "Could not load Oracle & Automation status." }, { status: 500 });
  }
}
