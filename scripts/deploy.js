import hre from "hardhat";

// The InayaCustody address this ProofRegistry deployment is paired with — registerMerkleRoot
// checks every caller against this contract's own assets(fileHash).owner, so the two are meant
// to be redeployed together if this address ever changes.
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const ProofRegistry = await hre.ethers.getContractFactory("InayaProofRegistry");
  const proofRegistry = await ProofRegistry.deploy(CUSTODY_ADDRESS);
  await proofRegistry.waitForDeployment();
  const proofRegistryAddress = await proofRegistry.getAddress();

  console.log("✅ InayaProofRegistry deployed to:", proofRegistryAddress);
  console.log("   Paired with InayaCustody at:", CUSTODY_ADDRESS);

  // No dummy registration here anymore — registerMerkleRoot now requires a REAL
  // InayaCustody-recorded owner for the fileHash, so a synthetic fileHash would just revert
  // with "Asset not found in InayaCustody". See scripts/verify-fix.cjs for end-to-end
  // verification against real Custody-registered assets.

  console.log("\n=== Is address ko apne frontend/backend mein save kar lo ===");
  console.log("NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS =", proofRegistryAddress);
  console.log("===============================================================\n");

  console.log("BscScan par verify karne ke liye ye command chalana:");
  console.log(`npx hardhat verify --network bscTestnet ${proofRegistryAddress} ${CUSTODY_ADDRESS}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});