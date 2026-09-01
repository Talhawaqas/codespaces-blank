#!/usr/bin/env node
// scripts/interop-aptos-wrapped.mjs -- submits the BSC attestation VAA to Aptos Testnet's Token
// Bridge to create the wrapped $INAYA there.
// Run with (from inaya-network-dapp/): node scripts/interop-aptos-wrapped.mjs

const APTOS_PRIVATE_KEY_HEX = "a04631351e6825ea5b914a967cd56ff6a3d9e6623e21e260b395cf0481b53845";
const ATTESTATION_TX = "0x09f6fabe0f111ce035a31c3262ffe0300d0cdf72a4b7f54811ed76a8b7cd7fb4";

async function main() {
  const { wormhole, signSendWait } = await import("@wormhole-foundation/sdk");
  const aptosPlatform = (await import("@wormhole-foundation/sdk/aptos")).default;
  const { getAptosSigner } = await import("@wormhole-foundation/sdk-aptos");

  const wh = await wormhole("Testnet", [aptosPlatform]);
  const chain = wh.getChain("Aptos");
  const rpc = await chain.getRpc();
  const signer = await getAptosSigner(rpc, APTOS_PRIVATE_KEY_HEX);
  console.log("Aptos wallet:", signer.address());

  const tb = await chain.getTokenBridge();

  console.log("Fetching attestation VAA...");
  const vaa = await wh.getVaa(ATTESTATION_TX, "TokenBridge:AttestMeta", 60_000);
  if (!vaa) throw new Error("VAA not available");
  console.log("VAA retrieved.");

  console.log("Submitting attestation VAA to Aptos Token Bridge...");
  const txGen = tb.submitAttestation(vaa, signer.address());
  const txids = await signSendWait(chain, txGen, signer);
  console.log("Submitted:", txids);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
