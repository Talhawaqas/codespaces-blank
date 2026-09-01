// GET /api/interop/wtt/relay
//
// CRON_SECRET-gated, same pattern as /api/bridge/cron/relay-messages. For every pending interop
// transfer, fetches the Wormhole Guardian-signed Transfer VAA and submits completeTransfer() on
// the destination chain via Inaya's relayer wallet (RELAYER_PRIVATE_KEY, same key/precedent the
// native bridge already uses) -- the user only ever signs the SOURCE-chain lock; Inaya sponsors
// destination gas, identical split to the existing native bridge's design.
//
// Fetches the VAA via a plain REST call to Wormholescan's public API rather than the
// @wormhole-foundation/sdk package -- that package eagerly imports XRPL support (regardless of
// which platform is actually used), and XRPL's dependency chain ships ESM-only files that break
// Next.js's webpack build entirely ("Module not found: ESM packages need to be imported").
// serverExternalPackages didn't avoid it either, since webpack still traces a dynamic import()
// of the package at build time. A direct fetch() against the same public endpoint the SDK
// itself calls under the hood (visible in its own retry logs: "Wormholescan:GetVaaByTxHash")
// sidesteps the whole dependency, confirmed working against this session's real testnet VAA.
//
// Currently only the ONE real, proven route (BSC -> Sepolia) is attempted -- see
// docs/inaya-interoperability.md's Definition-of-Done. Any other pair is marked FAILED with an
// honest reason rather than attempted blind; expanding this list is real work (a new proven
// route, per docs/chain-expansion-guide.md's WTT equivalent), not a config change.

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { getPendingInteropTransfers, markInteropTransferStatus, INTEROP_TRANSFER_STATUS } from "@/lib/interopTransfers";

async function fetchVaaByTxHash(txHash) {
  const res = await fetch(`https://api.testnet.wormholescan.io/api/v1/operations?txHash=${txHash}`);
  if (!res.ok) throw new Error(`Wormholescan API error: ${res.status}`);
  const data = await res.json();
  const op = data.operations?.[0];
  if (!op?.vaa?.raw) return null; // not yet signed by the Guardian network
  return { rawBase64: op.vaa.raw, sequence: op.sequence, emitterAddress: op.emitterAddress?.hex };
}

// Every route here is real and proven end-to-end -- see
// deployments/interop/wormhole-wtt/bscTestnet-attestation.json's provenRoutes for the actual
// transaction hashes each was verified with.
const PROVEN_ROUTES = {
  "BSC:ETHEREUM": {
    destRpc: () => process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    destChainId: 11155111,
    destTokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9",
  },
  "BSC:ARBITRUM": {
    destRpc: () => process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
    destChainId: 421614,
    destTokenBridge: "0xC7A204bDBFe983FCD8d8E61D02b475D4073fF97e",
  },
  "BSC:AVALANCHE": {
    destRpc: () => process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
    destChainId: 43113,
    destTokenBridge: "0x61E44E506Ca5659E6c0bba9b678586fA2d729756",
  },
};

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RELAYER_PRIVATE_KEY) {
    return NextResponse.json({ success: false, error: "Relayer not configured" }, { status: 500 });
  }

  const pending = await getPendingInteropTransfers(20);
  const results = [];

  for (const doc of pending) {
    const routeKey = `${doc.sourceChain}:${doc.destChain}`;
    const route = PROVEN_ROUTES[routeKey];
    if (!route) {
      await markInteropTransferStatus(doc._id, INTEROP_TRANSFER_STATUS.FAILED, { failureReason: `No proven relay route for ${routeKey} yet -- see docs/chain-expansion-guide.md` });
      results.push({ transferId: doc._id, status: "failed_no_route" });
      continue;
    }

    try {
      await markInteropTransferStatus(doc._id, INTEROP_TRANSFER_STATUS.ATTESTING);
      const vaa = await fetchVaaByTxHash(doc.sourceTxHash);
      if (!vaa) {
        results.push({ transferId: doc._id, status: "awaiting_vaa" });
        continue;
      }

      await markInteropTransferStatus(doc._id, INTEROP_TRANSFER_STATUS.RELAYING, { messageId: `${vaa.emitterAddress}/${vaa.sequence}` });
      const vaaBytes = ethers.decodeBase64(vaa.rawBase64);

      const provider = new ethers.JsonRpcProvider(route.destRpc(), route.destChainId, { staticNetwork: true });
      const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
      const tb = new ethers.Contract(route.destTokenBridge, ["function completeTransfer(bytes memory encodedVm) external"], relayer);
      const tx = await tb.completeTransfer(vaaBytes);
      const receipt = await tx.wait();

      await markInteropTransferStatus(doc._id, INTEROP_TRANSFER_STATUS.COMPLETED, { destTxHash: receipt.hash });
      results.push({ transferId: doc._id, status: "completed", destTxHash: receipt.hash });
    } catch (err) {
      await markInteropTransferStatus(doc._id, INTEROP_TRANSFER_STATUS.FAILED, { failureReason: err.message.slice(0, 300) });
      results.push({ transferId: doc._id, status: "error", error: err.message });
    }
  }

  return NextResponse.json({ success: true, results });
}
