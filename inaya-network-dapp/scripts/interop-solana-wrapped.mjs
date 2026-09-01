#!/usr/bin/env node
// scripts/interop-solana-wrapped.mjs
//
// Interop SOW -- submits the existing BSC attestation VAA to Solana Devnet's Token Bridge
// program to create the wrapped $INAYA there. Uses the Wormhole SDK's Solana platform (Solana's
// Token Bridge is a program with PDA-derived accounts, not a simple contract call like EVM --
// no manual-bypass equivalent to what worked around the EVM SDK bug).
//
// Run with (from inaya-network-dapp/):
//   node --env-file=../.env scripts/interop-solana-wrapped.mjs

import { wormhole, signSendWait } from "@wormhole-foundation/sdk";
import solana from "@wormhole-foundation/sdk/solana";
import { getSolanaSignAndSendSigner } from "@wormhole-foundation/sdk-solana";
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYPAIR_PATH = path.join(__dirname, "..", "..", "solana", "devnet-id.json");
const ATTESTATION_TX = "0x09f6fabe0f111ce035a31c3262ffe0300d0cdf72a4b7f54811ed76a8b7cd7fb4";

async function main() {
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")));
  const keypair = Keypair.fromSecretKey(secretKey);
  console.log("Solana wallet:", keypair.publicKey.toBase58());

  const wh = await wormhole("Testnet", [solana]);
  const solChain = wh.getChain("Solana");
  const rpc = await solChain.getRpc();

  const signer = await getSolanaSignAndSendSigner(rpc, keypair);

  const tb = await solChain.getTokenBridge();

  console.log("Fetching attestation VAA...");
  const vaa = await wh.getVaa(ATTESTATION_TX, "TokenBridge:AttestMeta", 60_000);
  if (!vaa) throw new Error("VAA not available");
  console.log("VAA retrieved.");

  console.log("Submitting attestation VAA to Solana Token Bridge (creates the wrapped token)...");
  const txGen = tb.submitAttestation(vaa, signer.address());
  const txids = await signSendWait(solChain, txGen, signer);
  console.log("Submitted:", txids);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
