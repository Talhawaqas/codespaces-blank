// src/lib/nodeChainReads.js
//
// Node Operator Dashboard SOW — read-only on-chain reads for tier,
// commission-adjacent earnings, and the 36-hour settlement timelock.
// Tier/commission (Entry 30% / Mid 40% / Enterprise 50%) is computed
// entirely on-chain by InayaNodeRegistry.sol's _calculateTier() — the
// off-chain `tier` string on the `nodes` doc is set once at registration
// and never revisited, so it is NOT authoritative. This file reads the
// contract directly instead, using the exact same ABI fragments already
// used elsewhere in this codebase (custody-sdk's node-daemon constants.js
// for `nodes(address)`, and settlements/release/route.js for
// `queuedSettlements`) — no new contract knowledge invented here.
//
// Every read is wrapped in a short in-memory TTL cache so a dashboard load
// never triggers a fresh RPC round trip on every request (SOW §20's
// caching requirement) — acceptable staleness for a read-only display
// value, never used to gate a write or a security decision.

import { ethers } from "ethers";

const NODE_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_NODE_REGISTRY_ADDRESS || "0xd12a38e8564d19797B19cF8F80b54DB09B3FD881";
const RPC_URL = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
const CACHE_TTL_MS = 60 * 1000;
const MAX_SETTLEMENTS_SCANNED = 500; // same defensive cap philosophy as the release cron's MAX_SETTLEMENTS_PER_RUN

// Same two ABI fragments already relied on elsewhere in this codebase --
// custody-sdk/packages/node-daemon/src/constants.js's NODE_REGISTRY_ABI for
// the node-info read, settlements/release/route.js's REGISTRY_ABI for the
// settlement-queue reads.
const REGISTRY_ABI = [
  "function nodes(address) view returns (address wallet, uint256 capacityGB, uint256 uptimeScore, uint8 tier, bool isRegistered, uint256 totalEarnedUsdt)",
  "function getQueuedSettlementsCount() view returns (uint256)",
  "function queuedSettlements(uint256) view returns (address operator, uint256 amount, uint256 unlockTime, bool released)",
];

const TIER_NAMES = ["Entry", "Mid", "Enterprise"];
const TIER_COMMISSION_PCT = { Entry: 30, Mid: 40, Enterprise: 50 };

let providerSingleton = null;
function getProvider() {
  if (!providerSingleton) providerSingleton = new ethers.JsonRpcProvider(RPC_URL);
  return providerSingleton;
}
function getRegistry() {
  return new ethers.Contract(NODE_REGISTRY_ADDRESS, REGISTRY_ABI, getProvider());
}

const cache = new Map(); // key -> {value, expiresAt}
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Reads this wallet's on-chain node record. Returns {isRegistered:false}
 *  (never throws, never fabricates a tier) when the wallet has no on-chain
 *  registration yet, or when the RPC call itself fails — the caller is
 *  expected to render an honest "not available" state in either case. */
export async function getOnChainNodeInfo(walletAddress) {
  const wallet = walletAddress.toLowerCase();
  return cached(`node:${wallet}`, async () => {
    try {
      const registry = getRegistry();
      const result = await registry.nodes(wallet);
      if (!result.isRegistered) return { isRegistered: false };
      const tierIndex = Number(result.tier);
      const tierName = TIER_NAMES[tierIndex] || "Entry";
      return {
        isRegistered: true,
        capacityGB: Number(result.capacityGB),
        uptimeScore: Number(result.uptimeScore),
        tier: tierName,
        commissionPct: TIER_COMMISSION_PCT[tierName] ?? null,
        totalEarnedUsdt: ethers.formatUnits(result.totalEarnedUsdt, 18),
      };
    } catch (err) {
      console.error("nodeChainReads.getOnChainNodeInfo failed:", err);
      return { isRegistered: false, error: "Could not reach the chain right now." };
    }
  });
}

/** Scans queuedSettlements for this operator (there is no per-operator
 *  index on-chain — same linear scan the release cron already does,
 *  capped the same defensive way). Returns [] on any RPC failure rather
 *  than throwing, since this backs a read-only dashboard section. */
export async function getSettlementsForOperator(walletAddress) {
  const wallet = walletAddress.toLowerCase();
  return cached(`settlements:${wallet}`, async () => {
    try {
      const registry = getRegistry();
      const count = Number(await registry.getQueuedSettlementsCount());
      const scanCount = Math.min(count, MAX_SETTLEMENTS_SCANNED);
      const now = Math.floor(Date.now() / 1000);
      const results = [];
      for (let i = 0; i < scanCount; i++) {
        const s = await registry.queuedSettlements(i);
        if (s.operator.toLowerCase() !== wallet) continue;
        const unlockTime = Number(s.unlockTime);
        results.push({
          settlementId: i,
          amount: ethers.formatUnits(s.amount, 18),
          unlockTime,
          released: s.released,
          isClaimable: !s.released && unlockTime <= now,
          secondsRemaining: s.released ? 0 : Math.max(0, unlockTime - now),
        });
      }
      return results;
    } catch (err) {
      console.error("nodeChainReads.getSettlementsForOperator failed:", err);
      return [];
    }
  });
}
