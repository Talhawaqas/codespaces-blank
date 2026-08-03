// scripts/deploy-staking.js
//
// Run with: npx hardhat run scripts/deploy-staking.js --network bscTestnet
//
// Deploys InayaStaking with your existing live $INAYA token address for
// BOTH stakingToken and rewardToken (they're the same token per the SOW).

const hre = require("hardhat");
const { ethers } = hre;

// Your already-deployed $INAYA token on BNB Chain Testnet
const INAYA_TOKEN_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  const Staking = await ethers.getContractFactory("InayaStaking");
  const staking = await Staking.deploy(INAYA_TOKEN_ADDRESS, INAYA_TOKEN_ADDRESS);
  await staking.waitForDeployment();

  const deployedAddress = await staking.getAddress();
  console.log("\n✅ InayaStaking deployed to:", deployedAddress);
  console.log("\n=== Save this in your frontend/backend env ===");
  console.log(`NEXT_PUBLIC_STAKING_ADDRESS = ${deployedAddress}`);
  console.log("===============================================\n");
  console.log("Verify on BscScan with:");
  console.log(
    `npx hardhat verify --network bscTestnet ${deployedAddress} ${INAYA_TOKEN_ADDRESS} ${INAYA_TOKEN_ADDRESS}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
