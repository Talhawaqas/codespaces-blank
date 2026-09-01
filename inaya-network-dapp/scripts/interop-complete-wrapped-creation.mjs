#!/usr/bin/env node
// scripts/interop-complete-wrapped-creation.mjs
//
// Interop SOW, Phase 3/5/11 -- step two of the WTT attestation flow. Fetches the Guardian-
// signed VAA for the attestation submitted by interop-attest-inaya.mjs, then submits it to a
// destination chain's Token Bridge to actually create the wrapped $INAYA there. Once this
// succeeds, a real transfer TO that destination chain becomes genuinely possible (the
// capabilityRegistry.js entry for that chain should be upgraded to TRANSFER_AVAILABLE only
// after this is confirmed on-chain -- never ahead of proof).
//
// Run with (from inaya-network-dapp/):
//   node --env-file=../.env scripts/interop-complete-wrapped-creation.mjs <destinationChain>
// e.g.:
//   node --env-file=../.env scripts/interop-complete-wrapped-creation.mjs Avalanche

import { wormhole, signSendWait } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import { getEvmSignerForKey } from "@wormhole-foundation/sdk-evm";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTESTATION_RECORD = path.join(__dirname, "..", "..", "deployments", "interop", "wormhole-wtt", "bscTestnet-attestation.json");

const RPC_BY_CHAIN = {
  Avalanche: { url: process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc", chainId: 43113 },
  Arbitrum: { url: process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc", chainId: 421614 },
  Sepolia: { url: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111 },
};

async function main() {
  const destChainName = process.argv[2];
  if (!destChainName || !RPC_BY_CHAIN[destChainName]) {
    throw new Error(`Usage: node interop-complete-wrapped-creation.mjs <${Object.keys(RPC_BY_CHAIN).join("|")}>`);
  }
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set.");

  const record = JSON.parse(fs.readFileSync(ATTESTATION_RECORD, "utf8"));
  console.log(`Fetching VAA for attestation tx ${record.txHash} (this can take a few minutes on testnet)...`);

  const wh = await wormhole("Testnet", [evm]);
  const vaa = await wh.getVaa(record.txHash, "TokenBridge:AttestMeta", 5 * 60 * 1000);
  if (!vaa) {
    console.log("VAA not yet available -- Guardian network hasn't signed it yet. Try again in a few minutes.");
    process.exitCode = 1;
    return;
  }
  console.log("VAA retrieved. Submitting to", destChainName, "Token Bridge to create the wrapped $INAYA...");

  const destChain = wh.getChain(destChainName);
  const { url, chainId } = RPC_BY_CHAIN[destChainName];
  const provider = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
  const signer = await getEvmSignerForKey(provider, deployerKey);

  const tb = await destChain.getTokenBridge();
  const submitTxs = tb.submitAttestation(vaa, signer.address());
  const txids = await signSendWait(destChain, submitTxs, signer);
  console.log("Wrapped $INAYA created on", destChainName, ". Transaction IDs:", txids);

  const wrapped = await tb.getWrappedAsset(record.tokenAddress ? { chain: "Bsc", address: record.tokenAddress } : undefined).catch(() => null);
  if (wrapped) console.log("Wrapped token address on", destChainName, ":", wrapped.toString());
}

main().catch((err) => {
  console.error("Wrapped-creation step failed:", err);
  process.exitCode = 1;
});
