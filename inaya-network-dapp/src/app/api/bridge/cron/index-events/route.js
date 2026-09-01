// GET /api/bridge/cron/index-events
//
// CRON_SECRET-gated, same pattern as /api/nodes/settlements/release. For every configured
// chain, scans that chain's InayaMessenger for MessageSent/MessageExecuted/MessageFailed events
// since the last processed block (bounded per run) and updates bridge_transfers accordingly --
// this is what makes the Mongo doc the actual source of truth for "pending/completed/failed"
// regardless of which chain a user initiated from (see CROSS_CHAIN_BRIDGE_GUIDE.md).

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { CHAINS } from "@/lib/chains";
import { getChainCursor, setChainCursor, recordTransferInitiated, markTransferStatus } from "@/lib/bridge";
import { getAdapter } from "@/lib/chain-adapters";

const MAX_BLOCKS_PER_RUN = 2000;

const MESSENGER_ABI = [
  "event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)",
  "event MessageExecuted(bytes32 indexed messageId)",
  "event MessageFailed(bytes32 indexed messageId, string reason)",
];

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const results = [];
  for (const [chainId, chain] of Object.entries(CHAINS)) {
    if (!chain.contracts.messenger) continue;
    try {
      const adapter = getAdapter(chainId, { useServerRpc: true });
      const provider = adapter.provider;
      const messenger = new ethers.Contract(chain.contracts.messenger, MESSENGER_ABI, provider);

      const fromBlock = (await getChainCursor(chainId)) + 1;
      const latest = await provider.getBlockNumber();
      const toBlock = Math.min(latest, fromBlock + MAX_BLOCKS_PER_RUN);
      if (toBlock < fromBlock) {
        results.push({ chainId: Number(chainId), scanned: 0 });
        continue;
      }

      const [sentEvents, executedEvents, failedEvents] = await Promise.all([
        messenger.queryFilter(messenger.filters.MessageSent(), fromBlock, toBlock),
        messenger.queryFilter(messenger.filters.MessageExecuted(), fromBlock, toBlock),
        messenger.queryFilter(messenger.filters.MessageFailed(), fromBlock, toBlock),
      ]);

      for (const ev of sentEvents) {
        const { messageId, message } = ev.args;
        await recordTransferInitiated({
          messageHash: messageId,
          sourceChainId: Number(message.sourceChainId),
          destChainId: Number(message.destChainId),
          amount: "0", // amount lives inside payload, opaque to the indexer -- dApp-initiated
                        // transfers already recorded the real amount via /initiate-transfer;
                        // this backfill path exists for non-dApp (SDK/CLI) senders.
          userAddress: ethers.ZeroAddress,
          sourceTxHash: ev.transactionHash,
          kind: "backfill",
          message: {
            sourceChainId: message.sourceChainId.toString(),
            sourceContract: message.sourceContract,
            destChainId: message.destChainId.toString(),
            destContract: message.destContract,
            nonce: message.nonce.toString(),
            msgType: message.msgType,
            payload: message.payload,
          },
        });
      }
      for (const ev of executedEvents) {
        await markTransferStatus(ev.args.messageId, "completed", { destTxHash: ev.transactionHash });
        // Additive, logged-only for now (Phase 3 of the chain-adapter SOW) -- not yet a hard
        // gate on "completed" status, since we haven't watched this log against real testnet
        // reorg behavior yet. Flipping to a hard gate is a deliberate follow-up decision.
        adapter.getFinalityStatus(ev.transactionHash).then((finality) => {
          if (!finality.finalized) {
            console.warn(`[index-events] chain ${chainId}: tx ${ev.transactionHash} marked completed with only ${finality.confirmations}/${finality.required} confirmations`);
          }
        }).catch((err) => console.warn(`[index-events] chain ${chainId}: finality check failed for ${ev.transactionHash}:`, err.message));
      }
      for (const ev of failedEvents) {
        await markTransferStatus(ev.args.messageId, "failed", { failureReason: ev.args.reason });
      }

      await setChainCursor(chainId, toBlock);
      results.push({ chainId: Number(chainId), scanned: toBlock - fromBlock + 1, sent: sentEvents.length, executed: executedEvents.length, failed: failedEvents.length });
    } catch (err) {
      results.push({ chainId: Number(chainId), error: err.message });
    }
  }

  return NextResponse.json({ success: true, results });
}
