// scripts/deploy-node-registry.cjs
//
// Deploys the corrected InayaNodeRegistry: commission rates fixed to 30/40/50 (matching the
// published Operator Manifesto, not the previous 50/60/70), plus the settlement timelock
// (queueSettlement/releaseSettlement) and SettlementSkipped event. Clean redeploy, not a
// migration -- 0 real node operators were registered on the old contract (confirmed on-chain
// before this run), so there's nothing real to carry over.
//
// Deploys with the SAME verifierWallet as before -- pointing it at a multisig is a separate
// setVerifierWallet() call once that's set up, decoupled from this deployment.

const hre = require("hardhat");

const USDT_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D"; // mUSDT (testnet mock)
const VERIFIER_WALLET = "0x618f429bF27Ef458B60c1211b9ca8b3CD5d9C175"; // existing verifier EOA, unchanged for now

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const NodeRegistry = await hre.ethers.getContractFactory("InayaNodeRegistry");
  const nodeRegistry = await NodeRegistry.deploy(USDT_ADDRESS, VERIFIER_WALLET);
  await nodeRegistry.waitForDeployment();
  const nodeRegistryAddress = await nodeRegistry.getAddress();

  console.log("✅ InayaNodeRegistry deployed to:", nodeRegistryAddress);
  console.log("   usdtToken:", USDT_ADDRESS);
  console.log("   verifierWallet:", VERIFIER_WALLET, "(unchanged -- repoint via setVerifierWallet once the multisig is ready)");

  console.log("\n=== Save this address ===");
  console.log("NEXT_PUBLIC_NODE_REGISTRY_ADDRESS =", nodeRegistryAddress);
  console.log("==========================\n");

  console.log("BscScan verify command:");
  console.log(`npx hardhat verify --network bscTestnet ${nodeRegistryAddress} ${USDT_ADDRESS} ${VERIFIER_WALLET}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
