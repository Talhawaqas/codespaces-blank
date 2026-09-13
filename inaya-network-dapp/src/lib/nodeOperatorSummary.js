// src/lib/nodeOperatorSummary.js
//
// Node Operator Dashboard SOW — the one per-node summary function shared
// by GET /api/nodes/operator/me (single node) and GET
// /api/nodes/operator/fleet (one call per linked wallet) so both surfaces
// are guaranteed to agree, rather than the fleet table quietly drifting
// from what the single-node view shows for the same wallet.

import { getNodeHistoryCollections, classifyNodeHealth } from "./nodeUptimeHistory.js";
import { getOnChainNodeInfo } from "./nodeChainReads.js";
import { ensureSecurityIndexes, getReputationSnapshot } from "./security.js";

/** Returns {error,status} or the full per-node summary object used by both
 *  /me and /fleet. walletAddress must already be lowercased by the
 *  caller (both existing call sites get it from a session, which always
 *  stores wallets lowercased). */
export async function getNodeOperatorSummary(walletAddress) {
  const { nodes } = await getNodeHistoryCollections();
  const node = await nodes.findOne({ nodeId: walletAddress });
  if (!node) return { error: "This wallet isn't registered as a node.", status: 404 };

  await ensureSecurityIndexes();
  const [reputation, onChain] = await Promise.all([
    getReputationSnapshot(walletAddress),
    getOnChainNodeInfo(walletAddress),
  ]);

  return {
    identity: {
      nodeId: node.nodeId,
      operatorWallet: node.operatorWallet,
      registeredAt: node.registeredAt,
    },
    status: classifyNodeHealth(node),
    telemetry: {
      lastHeartbeatAt: node.lastHeartbeatAt,
      uptimeScoreBps: node.uptimeScoreBps ?? null,
      totalCapacityGB: node.totalCapacityGB ?? 0,
      usedCapacityGB: node.usedCapacityGB ?? 0,
      shardsStored: node.shardsStored ?? 0,
      lastErrorAt: node.lastErrorAt ?? null,
      lastErrorMessage: node.lastErrorMessage ?? null,
    },
    version: {
      daemonVersion: node.daemonVersion ?? null,
      daemonUptimeSeconds: node.uptimeSeconds ?? null,
      restartCount: node.restartCount ?? null,
    },
    tier: onChain.isRegistered
      ? { source: "on_chain", name: onChain.tier, commissionPct: onChain.commissionPct, totalEarnedUsdt: onChain.totalEarnedUsdt }
      : { source: "unavailable", reason: onChain.error || "Not yet registered on-chain." },
    threatReporting: {
      scoreBps: reputation.scoreBps,
      totalConfirmed: reputation.totalConfirmed,
      totalFalsePositive: reputation.totalFalsePositive,
      checkpointed: reputation.checkpointed,
    },
  };
}
