// scripts/wire-sui-spoke.mjs
//
// Wires Sui Testnet in as a trusted spoke on BSC home's registries, same pattern as
// wire-aptos-spoke.mjs / solana/wire-devnet.mjs (Sui isn't EVM).
//
// Run with: node scripts/wire-sui-spoke.mjs

import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: "inaya-network-dapp/.env.local" });
dotenv.config({ path: ".env" });

const SUI_CHAIN_ID = 3_000_000_002n;
// The Sui BridgeState shared object's own address -- this deployment's stable on-chain identity,
// the Sui analogue of a contract address on EVM / a program pubkey on Solana / a module address
// on Aptos (see sui/programs/inaya_bridge_sui/sources/bridge.move's comment on why this, not the
// admin's personal address, is used as source_contract for outbound messages).
const SUI_BRIDGE_STATE_BYTES32 = "0x1162bff1172c016f0fa794fe2fa811b413764aca9398cf607d44eb04f7ba100a";
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
  const active = await registry.isChainActive(SUI_CHAIN_ID).catch(() => false);
  if (!active) {
    const tx = await registry.registerRemoteChain(SUI_CHAIN_ID, FAMILY_NON_EVM, "suiTestnet");
    await tx.wait();
    console.log("Registered Sui Testnet as remote chain:", tx.hash);
  } else {
    console.log("Sui Testnet already registered as active.");
  }

  const tx2 = await registry.setTrustedRemoteContract(SUI_CHAIN_ID, SUI_BRIDGE_STATE_BYTES32, true);
  await tx2.wait();
  console.log("Trusted Sui bridge sender:", tx2.hash);

  const bridgeHome = new ethers.Contract(bsc.bridge, BRIDGE_HOME_ABI, deployer);
  const tx3 = await bridgeHome.setSpokeBridgeAddress(SUI_CHAIN_ID, SUI_BRIDGE_STATE_BYTES32);
  await tx3.wait();
  console.log("Home bridge now routes chain", SUI_CHAIN_ID.toString(), "->", SUI_BRIDGE_STATE_BYTES32, tx3.hash);
}

main().catch((e) => { console.error(e); process.exit(1); });
