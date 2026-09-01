#!/usr/bin/env node
// scripts/interop-sui-wrapped.mjs
//
// Interop SOW -- submits the existing BSC attestation VAA to Sui Testnet's Token Bridge to
// create the wrapped $INAYA there.
//
// Run with (from inaya-network-dapp/): node scripts/interop-sui-wrapped.mjs

const SUI_PRIVATE_KEY = "suiprivkey1qrl3u797zgl0z2xd9em0hgdekstrmkq03e9nhgu4kuw3mw69l6ttcfx39rc";
const ATTESTATION_TX = "0x09f6fabe0f111ce035a31c3262ffe0300d0cdf72a4b7f54811ed76a8b7cd7fb4";

async function main() {
  const { wormhole, signSendWait } = await import("@wormhole-foundation/sdk");
  const sui = (await import("@wormhole-foundation/sdk/sui")).default;
  const { SuiSigner } = await import("@wormhole-foundation/sdk-sui");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");

  const wh = await wormhole("Testnet", [sui]);
  const suiChain = wh.getChain("Sui");
  const rpc = await suiChain.getRpc();

  const keypair = Ed25519Keypair.fromSecretKey(SUI_PRIVATE_KEY);
  const signer = new SuiSigner("Sui", rpc, keypair);
  console.log("Sui wallet:", signer.address());

  const tb = await suiChain.getTokenBridge();

  console.log("Fetching attestation VAA...");
  const vaa = await wh.getVaa(ATTESTATION_TX, "TokenBridge:AttestMeta", 60_000);
  if (!vaa) throw new Error("VAA not available");
  console.log("VAA retrieved.");

  console.log("Submitting attestation VAA to Sui Token Bridge...");
  const txGen = tb.submitAttestation(vaa, signer.address());
  const txids = await signSendWait(suiChain, txGen, signer);
  console.log("Submitted:", txids);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
