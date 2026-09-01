// src/lib/chain-adapters/interop/capabilityRegistry.js
//
// Interop-layer chain capability registry (Interop SOW, Phase 4 + Phase 12).
// Deliberately SEPARATE from ../registry.js's SUPPORT_LEVELS -- that registry
// tracks Inaya's OWN hand-rolled bridge (BSC/Sepolia/Fuji/Arbitrum Sepolia/
// Solana Devnet). This one tracks reach THROUGH the interop provider
// (Wormhole, per docs/interoperability-provider-evaluation.md), which is a
// much larger, honestly-mostly-undeployed chain set. Never conflate the two:
// a chain can be TRANSFER_TESTED on Inaya's own bridge while still being
// DISCOVERED here, or vice versa.
//
// Every entry below reflects real, sourced verification, not the provider's
// marketing chain-count -- see docs/interoperability-provider-evaluation.md
// for the citations. As of this file's writing, ZERO Inaya-side interop
// deployment exists yet (no NttManager, no WTT attestation for $INAYA on any
// chain) -- so every chain is at most Tier C / DISCOVERED-or-ROUTE_AVAILABLE
// until Phase 3's real deployment happens. This file must be updated only
// with evidence (a real deployed contract, a real tested transfer), never
// bumped ahead of proof.

export const TIERS = {
  A_DIRECT: "A", // Provider already has live infrastructure Inaya can use with no new deployment
  B_INTEGRATION: "B", // A config/registration step is required, but no new destination contract
  C_DESTINATION_DEPLOY: "C", // Inaya (or the provider, on Inaya's behalf) must deploy a destination-side token/program
  D_UNSUPPORTED: "D", // Not reachable through the selected provider at all
};

export const INTEROP_SUPPORT_LEVELS = {
  DISCOVERED: 0, // Chain identified as a target; no route work done
  ROUTE_AVAILABLE: 1, // Provider's core messaging is confirmed live on this chain (Guardian-observed)
  WALLET_AVAILABLE: 2, // A wallet connection path for this chain/ecosystem exists in Inaya's frontend
  TRANSFER_AVAILABLE: 3, // Inaya's NttManager/WTT attestation is deployed and peered -- a transfer CAN be sent
  TRANSFER_TESTED: 4, // A real testnet/devnet transfer has been sent and confirmed end-to-end
  STAKING_AVAILABLE: 5, // Cross-chain staking through this route is proven (mirrors ../registry.js's STAKING)
  FULL_INAYA_INTEGRATION: 6, // Full business/app functionality integrated, same bar as ../registry.js's FULL_ECOSYSTEM
};

export const INTEROP_LEVEL_LABELS = {
  [INTEROP_SUPPORT_LEVELS.DISCOVERED]: "Discovered",
  [INTEROP_SUPPORT_LEVELS.ROUTE_AVAILABLE]: "Route available",
  [INTEROP_SUPPORT_LEVELS.WALLET_AVAILABLE]: "Wallet available",
  [INTEROP_SUPPORT_LEVELS.TRANSFER_AVAILABLE]: "Transfer available",
  [INTEROP_SUPPORT_LEVELS.TRANSFER_TESTED]: "Transfer tested",
  [INTEROP_SUPPORT_LEVELS.STAKING_AVAILABLE]: "Staking available",
  [INTEROP_SUPPORT_LEVELS.FULL_INAYA_INTEGRATION]: "Full Inaya integration",
};

// Real chain IDs where known/needed for later wiring; several of these (Near, Injective, Sei,
// Sui, Aptos) are non-EVM and don't have a single numeric "chainId" the way EVM/Wormhole's own
// internal chain IDs do -- left null here deliberately rather than inventing one, to be filled
// in against Wormhole's actual chain-ID table when Phase 3 wiring starts.
export const INTEROP_CHAINS = {
  ETHEREUM: { label: "Ethereum", evmChainId: 1, testnetEvmChainId: 11155111 /* Sepolia, already an Inaya spoke */ },
  BSC: { label: "BNB Smart Chain", evmChainId: 56, testnetEvmChainId: 97 /* Inaya's home chain */ },
  ARBITRUM: { label: "Arbitrum", evmChainId: 42161, testnetEvmChainId: 421614 /* already an Inaya spoke */ },
  AVALANCHE: { label: "Avalanche", evmChainId: 43114, testnetEvmChainId: 43113 /* already an Inaya spoke */ },
  POLYGON: { label: "Polygon", evmChainId: 137, testnetEvmChainId: 80002 /* Amoy, discovered-only on Inaya's own bridge */ },
  BASE: { label: "Base", evmChainId: 8453, testnetEvmChainId: 84532 },
  OPTIMISM: { label: "Optimism", evmChainId: 10, testnetEvmChainId: 11155420 },
  SOLANA: { label: "Solana", evmChainId: null, testnetEvmChainId: null /* already an Inaya spoke, Devnet */ },
  SUI: { label: "Sui", evmChainId: null, testnetEvmChainId: null },
  APTOS: { label: "Aptos", evmChainId: null, testnetEvmChainId: null },
  NEAR: { label: "Near", evmChainId: null, testnetEvmChainId: null },
  INJECTIVE: { label: "Injective", evmChainId: null, testnetEvmChainId: null },
  SEI: { label: "Sei", evmChainId: null, testnetEvmChainId: null },
};

// Verified 2026-08-31 against Wormhole's own published chain list (wormhole.com/blockchains,
// cross-checked search results) -- every chain below is confirmed present on Wormhole's network.
// Tier C for all of them: $INAYA has no NTT/WTT deployment on ANY chain yet, so even though
// Wormhole's core messaging is live everywhere below, Inaya-side deployment is still required
// before a single one becomes usable. None are Tier A yet, honestly, because "Tier A" would mean
// zero Inaya-side work -- that's not true for a brand-new asset on any interoperability network.
const CAPABILITY = Object.fromEntries(
  Object.keys(INTEROP_CHAINS).map((key) => [
    key,
    {
      tier: TIERS.C_DESTINATION_DEPLOY,
      providerConfirmed: true, // Wormhole's core Guardian network is confirmed live on this chain
      level: INTEROP_SUPPORT_LEVELS.ROUTE_AVAILABLE, // provider reachable; nothing Inaya-specific deployed yet
    },
  ])
);

/** @returns {{ tier: string, providerConfirmed: boolean, level: number, levelLabel: string } | null} */
export function getInteropCapability(chainKey) {
  const entry = CAPABILITY[chainKey];
  if (!entry) return null;
  return { ...entry, levelLabel: INTEROP_LEVEL_LABELS[entry.level] };
}

/** Lists every chain this SOW targets, each honestly annotated -- the single source a UI or
 *  doc should read from before ever describing interop-layer chain support. Mirrors
 *  ../registry.js's listChainCapabilities() but for the interop layer specifically. */
export function listInteropCapabilities() {
  return Object.keys(INTEROP_CHAINS).map((key) => ({
    key,
    ...INTEROP_CHAINS[key],
    ...getInteropCapability(key),
  }));
}

/** True only once a real transfer has been sent and confirmed -- never claim "supported" below this bar. */
export function isInteropTransferProven(chainKey) {
  const cap = getInteropCapability(chainKey);
  return !!cap && cap.level >= INTEROP_SUPPORT_LEVELS.TRANSFER_TESTED;
}
