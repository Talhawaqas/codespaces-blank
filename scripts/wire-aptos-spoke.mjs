// scripts/wire-aptos-spoke.mjs
//
// Wires Aptos Testnet in as a trusted spoke on BSC home's registries, same pattern as Solana's
// solana/wire-devnet.mjs (Aptos isn't EVM, so wire-bridge-registries.js -- which only knows how
// to read deployments/bridge/*.json's EVM-shaped `.bridge` field -- doesn't apply).
//
// Run with: node scripts/wire-aptos-spoke.mjs

import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: "inaya-network-dapp/.env.local" });
dotenv.config({ path: ".env" });

const APTOS_CHAIN_ID = 2_000_000_002n;
const APTOS_BRIDGE_ADDRESS_BYTES32 = "0xc4bf038a4ed931ea21acf4a1da08ddd308a490b7fcd4c96d7592e6eba053efee";
const FAMILY_NON_EVM = 1;

const bsc = JSON.parse(fs.readFileSync("deployments/bridge/bscTestnet.json", "utf8"));

const REGISTRY_ABI = [
  "function isChainActive(uint256) view returns (bool)",
  "function registerRemoteChain(uint256 chainId, uint8 family, string name) external",
  "function setTrustedRemoteContract(uint256 chainId, bytes32 contractAddr, bool trusted) external",
];
const BRIDGE_HOME_ABI = ["function setSpokeBridgeAddress(uint256 destChainId, bytes32 spokeAddress) external"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const registry = new ethers.Contract(bsc.chainRegistry, REGISTRY_ABI, deployer);
  const active = await registry.isChainActive(APTOS_CHAIN_ID).catch(() => false);
  if (!active) {
    const tx = await registry.registerRemoteChain(APTOS_CHAIN_ID, FAMILY_NON_EVM, "aptosTestnet");
    await tx.wait();
    console.log("Registered Aptos Testnet as remote chain:", tx.hash);
  } else {
    console.log("Aptos Testnet already registered as active.");
  }

  const tx2 = await registry.setTrustedRemoteContract(APTOS_CHAIN_ID, APTOS_BRIDGE_ADDRESS_BYTES32, true);
  await tx2.wait();
  console.log("Trusted Aptos bridge sender:", tx2.hash);

  const bridgeHome = new ethers.Contract(bsc.bridge, BRIDGE_HOME_ABI, deployer);
  const tx3 = await bridgeHome.setSpokeBridgeAddress(APTOS_CHAIN_ID, APTOS_BRIDGE_ADDRESS_BYTES32);
  await tx3.wait();
  console.log("Home bridge now routes chain", APTOS_CHAIN_ID.toString(), "->", APTOS_BRIDGE_ADDRESS_BYTES32, tx3.hash);
}

main().catch((e) => { console.error(e); process.exit(1); });
