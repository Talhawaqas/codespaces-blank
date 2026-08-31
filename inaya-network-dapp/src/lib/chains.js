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
