#!/usr/bin/env node
// One-off diagnostic: what package ID does the SDK's own dynamic resolver currently
// return for Sui's core bridge / token bridge state objects, vs what's aborting.
async function main() {
  const { wormhole } = await import("@wormhole-foundation/sdk");
  const sui = (await import("@wormhole-foundation/sdk/sui")).default;
  const { getPackageId, getOriginalPackageId } = await import("@wormhole-foundation/sdk-sui");

  const wh = await wormhole("Testnet", [sui]);
  const suiChain = wh.getChain("Sui");
  const rpc = await suiChain.getRpc();
  const tb = await suiChain.getTokenBridge();

  console.log("tokenBridgeObjectId:", tb.tokenBridgeObjectId ?? tb.stateObjectId ?? "(unknown field name)");
  console.log("Keys on tb:", Object.keys(tb));

  const coreObjId = tb.coreBridgeObjectId ?? tb.coreObjectId;
  const tokenObjId = tb.tokenBridgeObjectId ?? tb.stateObjectId;

  if (tokenObjId) {
    const current = await getPackageId(rpc, tokenObjId);
    const original = await getOriginalPackageId(rpc, tokenObjId);
    console.log("Token bridge -- CURRENT package (dynamic field):", current);
    console.log("Token bridge -- ORIGINAL package (from type):", original);
  }
  if (coreObjId) {
    const current = await getPackageId(rpc, coreObjId);
    const original = await getOriginalPackageId(rpc, coreObjId);
    console.log("Core bridge -- CURRENT package (dynamic field):", current);
    console.log("Core bridge -- ORIGINAL package (from type):", original);
  }
}
main().catch((err) => { console.error("FAILED:", err); process.exit(1); });
