import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";

dotenv.config();

export default {
  solidity: {
    // Two compilers: 0.8.20 stays pinned for the 9 already-deployed/verified
    // contracts (do not bump their bytecode). 0.8.24 is added only for the
    // new governance/ contracts, which need it for OZ v5's ERC20Votes/Governor.
    // Hardhat picks the matching compiler per file based on its pragma.
    compilers: [
      { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 } } },
      // evmVersion "cancun" -- OZ v5's Bytes.sol uses the MCOPY opcode (EIP-5656),
      // which isn't in the default "paris" target. BSC mainnet/testnet enabled
      // Cancun-equivalent opcodes at the 2024 Fusaka-aligned hard fork, so this
      // is deployable there when Phase 2 actually ships.
      { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } }
    ]
  },
  networks: {
    // `npx hardhat node` always serves the built-in "hardhat" network, not a named http entry
    // below -- HH_CHAIN_ID lets each local-simulation node instance (Phase 2) actually serve a
    // genuinely distinct chainId, e.g. `HH_CHAIN_ID=31338 npx hardhat node --port 8546`.
    hardhat: {
      chainId: Number(process.env.HH_CHAIN_ID || 31337)
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/",
      chainId: 97,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    // Not used by anything yet -- added so scripts/deploy-hackathon-rewards.js
    // (and any other future mainnet deploy) has a real --network target to
    // point at once mainnet actually launches. Same accounts/key as bscTestnet.
    bscMainnet: {
      url: process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    // Cross-chain bridge spoke networks (SOW-1). Same deployer key as bscTestnet -- the
    // deployer wallet needs its own faucet-funded native gas token on each of these before a
    // real deploy: Sepolia ETH, Amoy POL, Fuji AVAX.
    sepolia: {
      url: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    avalancheFuji: {
      url: process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    // Local multi-node simulation (Phase 2) -- run `npx hardhat node --port 854<N>` once per
    // entry before deploying against these.
    localHome: { url: "http://127.0.0.1:8545", chainId: 31337 },
    localSepolia: { url: "http://127.0.0.1:8546", chainId: 31338 },
    localAmoy: { url: "http://127.0.0.1:8547", chainId: 31339 },
    localFuji: { url: "http://127.0.0.1:8548", chainId: 31340 }
  },
  etherscan: {
    // V2 Migration: Ab object ({ bscTestnet: key }) ki jagah direct string deni hai
    apiKey: process.env.BSCSCAN_API_KEY || ""
  },
  sourcify: {
    // Fuzool ki warning hide karne ke liye
    enabled: false
  }
};