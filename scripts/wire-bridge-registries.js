// scripts/wire-bridge-registries.js
//
// Second pass, run once per network AFTER every network has a deployments/bridge/<name>.json
// from scripts/deploy-bridge.js. Registers every OTHER deployed chain as trusted in THIS
// network's InayaChainRegistry, and (home only) records each spoke's bridge address so home
// knows where to route outbound TOKEN_MINT messages.
//
//   npx hardhat run scripts/wire-bridge-registries.js --network localHome
//   npx hardhat run scripts/wire-bridge-registries.js --network localSepolia
//   npx hardhat run scripts/wire-bridge-registries.js --network localAmoy
//   npx hardhat run scripts/wire-bridge-registries.js --network localFuji

import hre from "hardhat";
import fs from "fs";
import path from "path";

const { ethers, network } = hre;
const FAMILY_EVM = 0;
const DEPLOYMENTS_DIR = path.join(process.cwd(), "deployments", "bridge");

function loadAllDeployments() {
  const files = fs.readdirSync(DEPLOYMENTS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS_DIR, f), "utf8")));
}

async function main() {
  const all = loadAllDeployments();
  const self = all.find((d) => d.network === network.name);
  if (!self) throw new Error(`No deployment file for network "${network.name}" -- run deploy-bridge.js first.`);
  // Non-EVM deployment files (e.g. solanaDevnet.json) live in the same directory but have no
  // EVM-shaped `.bridge` address to register/trust here -- InayaChainRegistry.registerRemoteChain
  // only models EVM-style 20-byte addresses; Solana's own trust wiring is done on-chain via
  // solana/wire-devnet.mjs instead. Skip them rather than crash on a null address.
  const others = all.filter((d) => d.network !== network.name && d.bridge);

  const registry = await ethers.getContractAt("InayaChainRegistry", self.chainRegistry);

  for (const other of others) {
    const registered = await registry.isChainActive(other.chainId).catch(() => false);
    if (!registered) {
      const tx = await registry.registerRemoteChain(other.chainId, FAMILY_EVM, other.network);
      await tx.wait();
      console.log(`[${network.name}] registered remote chain ${other.chainId} (${other.network})`);
    }

    // Trust the other chain's bridge contract as a valid sender.
    const tx1 = await registry.setTrustedRemoteContract(other.chainId, ethers.zeroPadValue(other.bridge, 32), true);
    await tx1.wait();
    console.log(`[${network.name}] trusted bridge sender ${other.bridge} on chain ${other.chainId}`);

    // Home additionally trusts each spoke's staking gateway (STAKE_REQUEST sender) and records
    // where to route outbound TOKEN_MINT messages destined for that spoke.
    if (self.role === "home" && other.role === "spoke") {
      const tx2 = await registry.setTrustedRemoteContract(other.chainId, ethers.zeroPadValue(other.stakingGateway, 32), true);
      await tx2.wait();
      const bridge = await ethers.getContractAt("InayaTokenBridgeHome", self.bridge);
      const tx3 = await bridge.setSpokeBridgeAddress(other.chainId, ethers.zeroPadValue(other.bridge, 32));
      await tx3.wait();
      console.log(`[${network.name}] home bridge now routes chain ${other.chainId} -> ${other.bridge}`);
    }
  }

  console.log(`\nDone wiring "${network.name}". Repeat for every other network.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
