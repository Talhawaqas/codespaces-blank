// scripts/deploy-backup-registry.cjs
//
// Deploys InayaBackupRegistry (docs/backup-redundancy-architecture.md), pointed at the real,
// already-deployed InayaCustody contract for its owner-cross-check, same constructor-argument
// pattern as InayaProofRegistry's own deployment.

const hre = require("hardhat");

const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; // InayaCustody, live on BSC Testnet

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const BackupRegistry = await hre.ethers.getContractFactory("InayaBackupRegistry");
  const backupRegistry = await BackupRegistry.deploy(CUSTODY_ADDRESS);
  await backupRegistry.waitForDeployment();
  const address = await backupRegistry.getAddress();

  console.log("InayaBackupRegistry deployed to:", address);
  console.log("  custody:", CUSTODY_ADDRESS);

  console.log("\n=== Save this address ===");
  console.log("NEXT_PUBLIC_BACKUP_REGISTRY_ADDRESS =", address);
  console.log("==========================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
