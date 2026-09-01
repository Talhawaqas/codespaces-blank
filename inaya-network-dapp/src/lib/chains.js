// src/lib/chains.js
//
// Chain-id -> RPC/contract-address config for the cross-chain bridge (SOW-1). Home (BSC
// Testnet) keeps its existing NEXT_PUBLIC_INAYA_TOKEN_ADDRESS/NEXT_PUBLIC_STAKING_ADDRESS_V2;
// spokes get their own bridge/wrapped-token/staking-gateway addresses. This is the first place
// in this codebase that needs more than one RPC provider -- every other lib file/API route
// still talks to a single BSC-testnet provider.

export const CHAIN_IDS = {
  BSC_TESTNET: 97,
  SEPOLIA: 11155111,
  AMOY: 80002,
  FUJI: 43113,
  ARBITRUM_SEPOLIA: 421614,
  HEDERA_TESTNET: 296,
};

export const CHAINS = {
  [CHAIN_IDS.BSC_TESTNET]: {
    key: "bscTestnet",
    isHome: true,
    hexChainId: "0x61",
    name: "BNB Smart Chain Testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrl: process.env.NEXT_PUBLIC_BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/",
    serverRpcUrl: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/",
    blockExplorerUrl: "https://testnet.bscscan.com",
    contracts: {
      inayaToken: process.env.NEXT_PUBLIC_INAYA_TOKEN_ADDRESS,
      staking: process.env.NEXT_PUBLIC_STAKING_ADDRESS_V2,
      bridge: process.env.NEXT_PUBLIC_BRIDGE_BSC_TESTNET_ADDRESS,
      stakingGateway: process.env.NEXT_PUBLIC_STAKING_GATEWAY_ADDRESS,
      chainRegistry: process.env.NEXT_PUBLIC_CHAIN_REGISTRY_BSC_TESTNET_ADDRESS,
      messenger: process.env.NEXT_PUBLIC_MESSENGER_BSC_TESTNET_ADDRESS,
    },
  },
  [CHAIN_IDS.SEPOLIA]: {
    key: "sepolia",
    isHome: false,
    hexChainId: "0xaa36a7",
    name: "Ethereum Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC || "https://rpc.sepolia.org",
    serverRpcUrl: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
    blockExplorerUrl: "https://sepolia.etherscan.io",
    contracts: {
      wrappedInaya: process.env.NEXT_PUBLIC_INAYA_BRIDGED_SEPOLIA_ADDRESS,
      bridge: process.env.NEXT_PUBLIC_BRIDGE_SEPOLIA_ADDRESS,
      stakingGateway: process.env.NEXT_PUBLIC_STAKING_GATEWAY_SEPOLIA_ADDRESS,
      chainRegistry: process.env.NEXT_PUBLIC_CHAIN_REGISTRY_SEPOLIA_ADDRESS,
      messenger: process.env.NEXT_PUBLIC_MESSENGER_SEPOLIA_ADDRESS,
    },
  },
  [CHAIN_IDS.AMOY]: {
    key: "amoy",
    isHome: false,
    hexChainId: "0x13882",
    name: "Polygon Amoy",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrl: process.env.NEXT_PUBLIC_AMOY_RPC || "https://rpc-amoy.polygon.technology",
    serverRpcUrl: process.env.POLYGON_AMOY_RPC || "https://rpc-amoy.polygon.technology",
    blockExplorerUrl: "https://amoy.polygonscan.com",
    contracts: {
      wrappedInaya: process.env.NEXT_PUBLIC_INAYA_BRIDGED_AMOY_ADDRESS,
      bridge: process.env.NEXT_PUBLIC_BRIDGE_AMOY_ADDRESS,
      stakingGateway: process.env.NEXT_PUBLIC_STAKING_GATEWAY_AMOY_ADDRESS,
      chainRegistry: process.env.NEXT_PUBLIC_CHAIN_REGISTRY_AMOY_ADDRESS,
      messenger: process.env.NEXT_PUBLIC_MESSENGER_AMOY_ADDRESS,
    },
  },
  [CHAIN_IDS.FUJI]: {
    key: "fuji",
    isHome: false,
    hexChainId: "0xa869",
    name: "Avalanche Fuji",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrl: process.env.NEXT_PUBLIC_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
    serverRpcUrl: process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
    blockExplorerUrl: "https://testnet.snowtrace.io",
    contracts: {
      wrappedInaya: process.env.NEXT_PUBLIC_INAYA_BRIDGED_FUJI_ADDRESS,
      bridge: process.env.NEXT_PUBLIC_BRIDGE_FUJI_ADDRESS,
      stakingGateway: process.env.NEXT_PUBLIC_STAKING_GATEWAY_FUJI_ADDRESS,
      chainRegistry: process.env.NEXT_PUBLIC_CHAIN_REGISTRY_FUJI_ADDRESS,
      messenger: process.env.NEXT_PUBLIC_MESSENGER_FUJI_ADDRESS,
    },
  },
  // Universal Chain Adapter SOW, Phase 5 -- deployed + wired live (deployments/bridge/
  // arbitrumSepolia.json), same deploy-bridge.js/wire-bridge-registries.js scripts as every
  // other spoke above. See docs/chain-adapters.md.
  [CHAIN_IDS.ARBITRUM_SEPOLIA]: {
    key: "arbitrumSepolia",
    isHome: false,
    hexChainId: "0x66eee",
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Arbitrum Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
    serverRpcUrl: process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
    blockExplorerUrl: "https://sepolia.arbiscan.io",
    contracts: {
      wrappedInaya: process.env.NEXT_PUBLIC_INAYA_BRIDGED_ARBITRUM_SEPOLIA_ADDRESS,
      bridge: process.env.NEXT_PUBLIC_BRIDGE_ARBITRUM_SEPOLIA_ADDRESS,
      stakingGateway: process.env.NEXT_PUBLIC_STAKING_GATEWAY_ARBITRUM_SEPOLIA_ADDRESS,
      chainRegistry: process.env.NEXT_PUBLIC_CHAIN_REGISTRY_ARBITRUM_SEPOLIA_ADDRESS,
      messenger: process.env.NEXT_PUBLIC_MESSENGER_ARBITRUM_SEPOLIA_ADDRESS,
    },
  },
  // Hedera Testnet -- native EVM via Hedera Smart Contract Service (Hashio JSON-RPC relay), so
  // this reuses the identical spoke contracts/deploy scripts as Sepolia/Fuji/Arbitrum. See
  // hardhat.config.js's hederaTestnet entry.
  [CHAIN_IDS.HEDERA_TESTNET]: {
    key: "hederaTestnet",
    isHome: false,
    hexChainId: "0x128",
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrl: process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
    serverRpcUrl: process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
    blockExplorerUrl: "https://hashscan.io/testnet",
    contracts: {
      wrappedInaya: process.env.NEXT_PUBLIC_INAYA_BRIDGED_HEDERA_TESTNET_ADDRESS,
      bridge: process.env.NEXT_PUBLIC_BRIDGE_HEDERA_TESTNET_ADDRESS,
      stakingGateway: process.env.NEXT_PUBLIC_STAKING_GATEWAY_HEDERA_TESTNET_ADDRESS,
      chainRegistry: process.env.NEXT_PUBLIC_CHAIN_REGISTRY_HEDERA_TESTNET_ADDRESS,
      messenger: process.env.NEXT_PUBLIC_MESSENGER_HEDERA_TESTNET_ADDRESS,
    },
  },
};

// Non-EVM metadata only -- Solana has no bridge contract addresses in this shape (see
// solana/programs/inaya-bridge-solana), listed here purely so the dApp's chain picker can show
// it as a supported destination.
export const SOLANA_DEVNET_CHAIN_ID = 1_000_000_002;
export const SOLANA_META = {
  key: "solanaDevnet",
  isHome: false,
  isEvm: false,
  name: "Solana Devnet",
  cluster: "devnet",
};

// Non-EVM metadata only -- Aptos has no bridge contract addresses in this shape (see
// aptos/programs/inaya-bridge-aptos), listed here purely so the dApp's chain picker can show it
// as a supported destination.
export const APTOS_TESTNET_CHAIN_ID = 2_000_000_002;
export const APTOS_META = {
  key: "aptosTestnet",
  isHome: false,
  isEvm: false,
  name: "Aptos Testnet",
  cluster: "testnet",
};

// Non-EVM metadata only -- Sui has no bridge contract addresses in this shape (see
// sui/programs/inaya_bridge_sui), listed here purely so the dApp's chain picker can show it as a
// supported destination.
export const SUI_TESTNET_CHAIN_ID = 3_000_000_002;
export const SUI_META = {
  key: "suiTestnet",
  isHome: false,
  isEvm: false,
  name: "Sui Testnet",
  cluster: "testnet",
};

export function getChain(chainId) {
  return CHAINS[Number(chainId)] ?? null;
}

export function listSupportedChains() {
  return Object.entries(CHAINS).map(([chainId, chain]) => ({ chainId: Number(chainId), ...chain }));
}

export function toWalletAddEthereumChainParams(chainId) {
  const chain = getChain(chainId);
  if (!chain) return null;
  return {
    chainId: chain.hexChainId,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [chain.rpcUrl],
    blockExplorerUrls: [chain.blockExplorerUrl],
  };
}

/// Generic switch/add-chain helper, parameterized by target chainId instead of hardcoded to one
/// chain. Used directly by the /bridge page's chain picker, and by page.js's own
/// ensureCorrectNetwork() (which wraps this with its own "already on BSC testnet?" check and
/// user-facing status messages, since that page only ever targets BSC testnet).
export async function ensureChain(provider, chainId) {
  const hexChainId = getChain(chainId)?.hexChainId;
  if (!hexChainId) throw new Error(`Unsupported chainId: ${chainId}`);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await provider.request({ method: "wallet_addEthereumChain", params: [toWalletAddEthereumChainParams(chainId)] });
    } else {
      throw switchError;
    }
  }
}
