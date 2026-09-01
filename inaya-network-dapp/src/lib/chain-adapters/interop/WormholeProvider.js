// src/lib/chain-adapters/interop/WormholeProvider.js
//
// Wormhole implementation of InteropProvider (Interop SOW, Phase 2-3).
// Per docs/interoperability-provider-evaluation.md: NTT (hub-and-spoke,
// native $INAYA, no wrapping) is the primary mode -- it's the closest
// structural match to Inaya's existing hand-rolled bridge. WTT (wrapped,
// lock-and-mint) is the documented fallback for chains NTT doesn't reach
// (Near/Injective/Sei-class -- see the evaluation doc's comparison table).
//
// NOTHING here is deployed yet. Every method is a real, correctly-shaped
// stub documenting exactly which Wormhole SDK/CLI call it will wrap, same
// pattern this codebase already uses for ChainAdapter's still-unimplemented
// initiateTransfer/getTransferStatus (../ChainAdapter.js) -- declare the
// real interface honestly, implement only once there's real deployed
// infrastructure to verify against. No mainnet deployment is in scope for
// this SOW at all; testnet/devnet only, per the SOW's explicit instruction.

import { InteropProvider } from "./InteropProvider.js";
import { chainToPlatform, contracts, finality } from "@wormhole-foundation/sdk-base";
import { INTEROP_CHAINS } from "./capabilityRegistry.js";

export const WORMHOLE_MODE = { NTT: "ntt", WTT: "wtt" };

// Maps Inaya's own chain keys (capabilityRegistry.js) to the Wormhole SDK's own chain-name
// strings -- the two vocabularies differ (Inaya: "BSC", Wormhole SDK: "Bsc").
//
// CORRECTED (real bug, found while completing a real testnet transfer -- see
// deployments/interop/wormhole-wtt/): for chains where a given mainnet family has MULTIPLE
// registered Wormhole testnets, "Testnet" + the mainnet family name does NOT resolve to
// Inaya's actual target testnet -- it silently returns a DIFFERENT chain's addresses.
// Confirmed directly: contracts.tokenBridge('Testnet','Ethereum') !== contracts.tokenBridge
// ('Testnet','Sepolia') (different addresses, different Wormhole chain IDs -- 2 vs 10002).
// Submitting a real transferTokens() call with the wrong chain ID (2 instead of 10002)
// reverted on-chain with InvalidTargetChain() once it reached the destination -- that's how
// this was caught, not by inspection. Ethereum/Arbitrum/Base/Optimism now map to their
// Sepolia-family testnet-specific SDK names, matching Inaya's own real testnet spokes.
// POLYGON has no entry -- verified there is no "PolygonAmoy" in the SDK's chain list at all
// (only "Polygon" mainnet and "PolygonSepolia", a DIFFERENT, unrelated Polygon testnet) --
// Wormhole does not currently reach Inaya's actual Amoy target, so it's honestly excluded
// rather than mapped to a testnet that isn't the one Inaya deployed to.
const INAYA_KEY_TO_WORMHOLE_CHAIN = {
  ETHEREUM: "Sepolia", BSC: "Bsc", ARBITRUM: "ArbitrumSepolia", AVALANCHE: "Avalanche",
  BASE: "BaseSepolia", OPTIMISM: "OptimismSepolia", SOLANA: "Solana",
  SUI: "Sui", APTOS: "Aptos", NEAR: "Near", INJECTIVE: "Injective", SEI: "Sei",
  // POLYGON deliberately omitted -- see comment above.
};

export class WormholeProvider extends InteropProvider {
  constructor() {
    super("wormhole");
  }

  /** REAL, live query against @wormhole-foundation/sdk-base's own chain-contract registry --
   *  not Inaya's own capabilityRegistry.js (which tracks INAYA-SIDE deployment state, a
   *  separate question). Returns only chains where Wormhole's own core infrastructure
   *  (Core Bridge + Token Bridge) is confirmed deployed on Testnet, which is real
   *  verification of "the provider's network reaches this chain" -- not marketing, not a
   *  hardcoded list Inaya maintains by hand and could let drift out of date. */
  async getSupportedChains() {
    const out = [];
    for (const [inayaKey, wormholeChain] of Object.entries(INAYA_KEY_TO_WORMHOLE_CHAIN)) {
      let coreBridge = null;
      let tokenBridge = null;
      try {
        coreBridge = contracts.coreBridge("Testnet", wormholeChain);
        tokenBridge = contracts.tokenBridge("Testnet", wormholeChain);
      } catch {
        // Chain genuinely not in the SDK's registry for Testnet -- excluded, not silently included.
      }
      if (!coreBridge || !tokenBridge) continue;
      out.push({
        chainId: INTEROP_CHAINS[inayaKey]?.testnetEvmChainId ?? null,
        family: chainToPlatform(wormholeChain),
        mode: WORMHOLE_MODE.WTT, // confirmed via tokenBridge; NTT confirmation would need Inaya's own deployed NttManager, which doesn't exist yet
        inayaKey,
        wormholeChain,
        coreBridge,
        tokenBridge,
        finalityBlocks: finality.finalityThreshold(wormholeChain) ?? null,
      });
    }
    return out;
  }

  // getRoute(sourceChainId, destChainId) -> checks whether both chains have a deployed
  // NttManager with the OTHER chain registered as a peer (NTT's "registerPeer" step),
  // falling back to WTT attestation-existence for chains NTT doesn't cover. Still
  // unimplemented -- unlike getSupportedChains() above, this needs Inaya's OWN deployment
  // state (deployments/interop/wormhole-ntt/*.json), which doesn't exist until Phase 3 ships.

  // estimateFee(params) -> wraps the Wormhole SDK's fee-estimation call for the chosen
  // mode (NTT: protocol message fee + destination gas; WTT: protocol message fee +
  // destination gas, or 0 if using automatic relay, whose relayer absorbs destination gas).

  // sendTransfer(params) -> NTT: NttManager.transfer(); WTT: TokenBridge.transferTokens()
  // + attestation if the destination has never seen $INAYA before. Real transaction,
  // real gas, real Guardian-network attestation wait.

  // getTransferStatus(transferId) -> wraps the Wormhole SDK's VAA/attestation lookup,
  // mapped onto Inaya's own PENDING/PROCESSING/ATTESTING/RELAYING/COMPLETED/FAILED
  // status set (see docs/interoperability-provider-evaluation.md's status model).
}
