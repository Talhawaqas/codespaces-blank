// app/api/nodes/settlements/release/route.js
//
// GET /api/nodes/settlements/release
//
// Backend relayer for the settlement timelock (decision C of the Node Registry SOW): the
// manifesto promises operators never have to manually claim their commission, but
// InayaNodeRegistry.releaseSettlement() is deliberately a separate, publicly-callable step
// from queueSettlement() (see contracts/InayaNodeRegistry.sol) — the whole point of the
// timelock is that nobody, including us, can push funds out early. This route is the "anyone"
// in "anyone can call it once unlocked": it scans queuedSettlements for entries whose
// unlockTime has passed and aren't yet released, and calls releaseSettlementsBatch() with a
// dedicated relayer wallet that pays its own gas. It carries no special on-chain authority —
// queueSettlement/queueSettlementsBatch stay gated behind the verifier Safe multisig; this
// route can only ever release money that a verifier already queued and the timelock already
// cleared.
//
// Triggered by Vercel Cron (see vercel.json). Vercel automatically attaches
// `Authorization: Bearer $CRON_SECRET` to cron-triggered requests when CRON_SECRET is set,
// which is what the check below verifies — same shared-secret philosophy as the admin routes'
// ?key= gate, just via header since this is a machine caller, not a browser.

import { NextResponse } from "next/server";
import { ethers } from "ethers";

const NODE_REGISTRY_ADDRESS =
  process.env.NEXT_PUBLIC_NODE_REGISTRY_ADDRESS || "0xd12a38e8564d19797B19cF8F80b54DB09B3FD881";
const RPC_URL = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";

// Hard cap per run — keeps a single cron invocation's gas bill and RPC round-trips bounded
// even if a backlog builds up; anything left over gets picked up on the next run.
const MAX_SETTLEMENTS_PER_RUN = 50;

const REGISTRY_ABI = [
  "function getQueuedSettlementsCount() view returns (uint256)",
  "function queuedSettlements(uint256) view returns (address operator, uint256 amount, uint256 unlockTime, bool released)",
  "function releaseSettlementsBatch(uint256[] calldata _settlementIds) external",
  "event SettlementReleased(uint256 indexed settlementId, address indexed operator, uint256 amount)",
];

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RELAYER_PRIVATE_KEY) {
    console.error("Settlement relayer: RELAYER_PRIVATE_KEY not configured");
    return NextResponse.json({ success: false, error: "Relayer not configured" }, { status: 500 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    const registry = new ethers.Contract(NODE_REGISTRY_ADDRESS, REGISTRY_ABI, relayer);

    const count = await registry.getQueuedSettlementsCount();
    const now = Math.floor(Date.now() / 1000);
    const eligibleIds = [];

    for (let i = 0; i < count && eligibleIds.length < MAX_SETTLEMENTS_PER_RUN; i++) {
      const s = await registry.queuedSettlements(i);
      if (!s.released && Number(s.unlockTime) <= now) {
        eligibleIds.push(i);
      }
    }

    if (eligibleIds.length === 0) {
      return NextResponse.json({ success: true, released: 0, message: "Nothing eligible for release." });
    }

    const tx = await registry.releaseSettlementsBatch(eligibleIds);
    const receipt = await tx.wait();
    const releasedEvents = receipt.logs
      .map((log) => {
        try {
          return registry.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "SettlementReleased")
      .map((event) => ({
        settlementId: event.args.settlementId.toString(),
        operator: event.args.operator,
        amount: ethers.formatUnits(event.args.amount, 18),
      }));

    console.log(`Settlement relayer: released ${releasedEvents.length} settlement(s), tx ${receipt.hash}`);

    return NextResponse.json({
      success: true,
      released: releasedEvents.length,
      txHash: receipt.hash,
      settlements: releasedEvents,
    });
  } catch (err) {
    console.error("Settlement relayer error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
