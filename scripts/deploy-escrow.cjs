// scripts/deploy-escrow.js
// Usage: npx hardhat run scripts/deploy-escrow.js --network bscTestnet

const hre = require("hardhat");

async function main() {
  const USDT_TOKEN_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D"; // your Mock USDT

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const Escrow = await hre.ethers.getContractFactory("InayaCorporateEscrow");
  const escrow = await Escrow.deploy(USDT_TOKEN_ADDRESS);
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  console.log("InayaCorporateEscrow deployed to:", escrowAddress);
  console.log("\nAdd to your .env / page.js:");
  console.log("NEXT_PUBLIC_CORPORATE_ESCROW_ADDRESS =", escrowAddress);
  console.log("\nVerify with:");
  console.log(`npx hardhat verify --network bscTestnet ${escrowAddress} ${USDT_TOKEN_ADDRESS}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
