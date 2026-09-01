#!/usr/bin/env node
// scripts/interop-attest-inaya.mjs
//
// Interop SOW, Phase 3/5/11 -- the first real, live action against Wormhole's network.
// Registers $INAYA's token attestation on BSC Testnet via Wormhole's Token Bridge (WTT), the
// documented fallback mode from docs/interoperability-provider-evaluation.md. This is a single
// real transaction using Wormhole's ALREADY-DEPLOYED Token Bridge contract on BSC Testnet
// (confirmed live via @wormhole-foundation/sdk-base, see WormholeProvider.getSupportedChains())
// -- no new contract deployment, no CLI/Foundry/Anchor toolchain needed, unlike NTT.
//
// This does NOT complete a transfer -- it's the prerequisite step ("first use" registration)
// that makes $INAYA transferable via WTT to any chain afterward. A real cross-chain transfer
// is the next script once this lands.
//
// Run with (from inaya-network-dapp/, so its own node_modules resolves the SDK):
//   node --env-file=../.env scripts/interop-attest-inaya.mjs

import { wormhole, Wormhole, signSendWait } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import { getEvmSignerForKey } from "@wormhole-foundation/sdk-evm";
import { ethers } from "ethers";

const BSC_TESTNET_INAYA_TOKEN = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e"; // deployments/bridge/bscTestnet.json's real $INAYA

async function main() {
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in environment.");

  console.log("Initializing Wormhole SDK (Testnet, EVM platform)...");
  const wh = await wormhole("Testnet", [evm]);
  const bsc = wh.getChain("Bsc");

  const tokenId = Wormhole.tokenId(bsc.chain, BSC_TESTNET_INAYA_TOKEN);

  console.log(`Checking whether $INAYA (${BSC_TESTNET_INAYA_TOKEN}) is already attested on BSC Testnet's Token Bridge...`);
  const tb = await bsc.getTokenBridge();
  const alreadyWrapped = await tb.isWrappedAsset(BSC_TESTNET_INAYA_TOKEN).catch(() => false);
  if (alreadyWrapped) {
    console.log("This address is itself a wrapped asset on BSC -- unexpected, stopping. Verify BSC_TESTNET_INAYA_TOKEN is correct.");
    return;
  }

  const rpcUrl = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/";
  const provider = new ethers.JsonRpcProvider(rpcUrl, 97, { staticNetwork: true }); // staticNetwork -- see EVMAdapter.js's comment on why, same hang bug applies here
  const signer = await getEvmSignerForKey(provider, deployerKey);

  console.log(`Submitting createAttestation() from ${signer.address()} on BSC Testnet...`);
  const attestTxs = tb.createAttestation(BSC_TESTNET_INAYA_TOKEN);
  const txids = await signSendWait(bsc, attestTxs, signer);
  console.log("Attestation submitted. Transaction IDs:", txids);
  console.log("\nDone. Once the Guardian network signs the resulting VAA (may take a few minutes on testnet),");
  console.log("that VAA can be submitted on a destination chain's Token Bridge to create the wrapped $INAYA there.");
  console.log("Record the VAA/txid above in deployments/interop/wormhole-wtt/bscTestnet-attestation.json for the next step.");
}

main().catch((err) => {
  console.error("Attestation failed:", err);
  process.exitCode = 1;
});
