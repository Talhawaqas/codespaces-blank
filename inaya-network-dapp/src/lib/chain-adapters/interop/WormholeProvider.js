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

export const WORMHOLE_MODE = { NTT: "ntt", WTT: "wtt" };

export class WormholeProvider extends InteropProvider {
  constructor() {
    super("wormhole");
  }

  // getSupportedChains() -> will read Inaya's own deployed-NttManager/WTT-attestation
  // registry (deployments/interop/wormhole-ntt/*.json, once Phase 3's real deployment
  // exists) -- NOT the Wormhole network's full chain list, which would overclaim.

  // getRoute(sourceChainId, destChainId) -> checks whether both chains have a deployed
  // NttManager with the OTHER chain registered as a peer (NTT's "registerPeer" step),
  // falling back to WTT attestation-existence for chains NTT doesn't cover.

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
