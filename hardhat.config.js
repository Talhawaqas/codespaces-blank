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
    }
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