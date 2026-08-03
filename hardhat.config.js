import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";

dotenv.config();

export default {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/",
      chainId: 97,
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