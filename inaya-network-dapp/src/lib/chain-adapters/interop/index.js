// src/lib/chain-adapters/interop/index.js
//
// Barrel export for the provider-neutral interoperability layer
// (Interop SOW, Phase 2). getInteropProvider() is the one entry point
// business logic should call -- it never imports WormholeProvider/
// LayerZeroProvider directly, so swapping/adding a provider later doesn't
// touch call sites.

import { WormholeProvider } from "./WormholeProvider.js";

export { InteropProvider } from "./InteropProvider.js";
export { WormholeProvider, WORMHOLE_MODE } from "./WormholeProvider.js";
export { LayerZeroProvider } from "./LayerZeroProvider.js";
export {
  TIERS,
  INTEROP_SUPPORT_LEVELS,
  INTEROP_LEVEL_LABELS,
  INTEROP_CHAINS,
  getInteropCapability,
  listInteropCapabilities,
  isInteropTransferProven,
} from "./capabilityRegistry.js";
export {
  WALLET_FAMILIES,
  WALLET_FAMILY_ADAPTERS,
  getWalletFamilyForChain,
  isWalletReady,
} from "./walletFamilies.js";

let cachedProvider = null;

/** @returns {import("./InteropProvider.js").InteropProvider}
 *  Wormhole is the only real (if still-unimplemented-per-method) provider,
 *  per docs/interoperability-provider-evaluation.md's recommendation. */
export function getInteropProvider() {
  if (!cachedProvider) cachedProvider = new WormholeProvider();
  return cachedProvider;
}
