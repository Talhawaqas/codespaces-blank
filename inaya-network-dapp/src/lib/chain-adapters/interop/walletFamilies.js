// src/lib/chain-adapters/interop/walletFamilies.js
//
// Interop SOW, Phase 7. Per the SOW's own instruction: "Use the wallet
// adapter recommended by the selected interoperability ecosystem. Do not
// force MetaMask onto non-EVM chains." This file is the routing table --
// which wallet FAMILY each interop-layer chain needs, and which real,
// specific wallet-adapter package is the recommended one for it.
//
// Deliberately NOT installing 4 new wallet SDKs yet (Sui/Aptos/Near/
// Cosmos-family) -- there is no live NTT/WTT deployment for any of these
// chains yet (docs/multichain-support-matrix.md), so a wallet-connect flow
// would have nothing real to do once connected. Adding that weight to the
// bundle now, before it's wired to anything, is exactly the kind of
// unnecessary scope this codebase's existing conventions avoid (see
// ../ChainAdapter.js's initiateTransfer/getTransferStatus stubs, or
// ../interop/WormholeProvider.js's sendTransfer stub -- same discipline:
// declare the real interface and the real dependency choice now, install
// and wire the implementation once there's a live route for it to serve).
//
// EVM (MetaMask/WalletConnect) and Solana (Phantom/Solflare) already work
// today -- src/app/page.js's window.ethereum path and
// src/components/bridge/SolanaWalletProviders.jsx respectively. Both are
// listed here too, so this file is the single place that answers "which
// wallet does chain X need," rather than that logic being implicit/
// scattered across frontend components.

export const WALLET_FAMILIES = {
  EVM: "evm",
  SOLANA: "solana",
  SUI: "sui",
  APTOS: "aptos",
  NEAR: "near",
  COSMOS: "cosmos", // Injective, Sei -- both Cosmos-SDK chains, both use the Cosmos wallet ecosystem
};

// Recommended adapter package per family -- verified against each ecosystem's own current
// wallet-standard tooling, not guessed. Only EVM and SOLANA are installed dependencies today;
// the rest are the researched, real choice to install WHEN Phase 3 gives them something to
// connect to (see the file header comment above for why that's deliberately deferred).
export const WALLET_FAMILY_ADAPTERS = {
  [WALLET_FAMILIES.EVM]: { installed: true, package: "window.ethereum (existing) / @reown/appkit (already a dependency)", notes: "Already wired -- src/app/page.js" },
  [WALLET_FAMILIES.SOLANA]: { installed: true, package: "@solana/wallet-adapter-react (existing)", notes: "Already wired -- src/components/bridge/SolanaWalletProviders.jsx" },
  [WALLET_FAMILIES.SUI]: { installed: false, package: "@mysten/dapp-kit", notes: "Sui's own official wallet-standard React kit (Sui Wallet, Suiet, others)" },
  [WALLET_FAMILIES.APTOS]: { installed: false, package: "@aptos-labs/wallet-adapter-react", notes: "Aptos Labs' official adapter (Petra, Martian, others)" },
  [WALLET_FAMILIES.NEAR]: { installed: false, package: "@near-wallet-selector/core", notes: "Near Foundation's official wallet selector" },
  [WALLET_FAMILIES.COSMOS]: { installed: false, package: "@cosmos-kit/react", notes: "Covers both Injective and Sei (Keplr, Leap, others) -- one adapter for both Cosmos-SDK chains" },
};

const CHAIN_KEY_TO_FAMILY = {
  ETHEREUM: WALLET_FAMILIES.EVM, BSC: WALLET_FAMILIES.EVM, ARBITRUM: WALLET_FAMILIES.EVM,
  AVALANCHE: WALLET_FAMILIES.EVM, POLYGON: WALLET_FAMILIES.EVM, BASE: WALLET_FAMILIES.EVM, OPTIMISM: WALLET_FAMILIES.EVM,
  SOLANA: WALLET_FAMILIES.SOLANA,
  SUI: WALLET_FAMILIES.SUI,
  APTOS: WALLET_FAMILIES.APTOS,
  NEAR: WALLET_FAMILIES.NEAR,
  INJECTIVE: WALLET_FAMILIES.COSMOS,
  SEI: WALLET_FAMILIES.COSMOS,
};

/** @returns {{ family: string, installed: boolean, package: string, notes: string } | null} */
export function getWalletFamilyForChain(chainKey) {
  const family = CHAIN_KEY_TO_FAMILY[chainKey];
  if (!family) return null;
  return { family, ...WALLET_FAMILY_ADAPTERS[family] };
}

/** True only for chains whose wallet adapter is an installed, working dependency today --
 *  never claim a chain is wallet-ready because a package NAME was chosen, only once it's
 *  actually installed and wired (mirrors capabilityRegistry.js's "never claim ahead of proof"). */
export function isWalletReady(chainKey) {
  return !!getWalletFamilyForChain(chainKey)?.installed;
}
