// scripts/deploy-vault.js
// Usage: npx hardhat run scripts/deploy-vault.js --network bscTestnet

const hre = require("hardhat");

async function main() {
  // Your existing deployed addresses — update if any of these have changed.
  const INAYA_TOKEN_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";
  const USDT_TOKEN_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D";
  const STAKING_CONTRACT_ADDRESS = "0xc465279444Cb0E10c69D0769CDae31E457eA660f"; // InayaStaking
  const OPERATIONAL_TREASURY_ADDRESS = "0x618f429bF27Ef458B60c1211b9ca8b3CD5d9C175"; // reusing OPERATOR_POOL_ADDRESS — change if you want a separate treasury wallet

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const Vault = await hre.ethers.getContractFactory("InayaEgressTimelockVault");
  const vault = await Vault.deploy(
    INAYA_TOKEN_ADDRESS,
    USDT_TOKEN_ADDRESS,
    STAKING_CONTRACT_ADDRESS,
    OPERATIONAL_TREASURY_ADDRESS
  );
  await vault.waitForDeployment();

  const vaultAddress = await vault.getAddress();
  console.log("InayaEgressTimelockVault deployed to:", vaultAddress);
  console.log("\nAdd to your .env / page.js:");
  console.log("NEXT_PUBLIC_EGRESS_VAULT_ADDRESS =", vaultAddress);
  console.log("\nVerify with:");
  console.log(
    `npx hardhat verify --network bscTestnet ${vaultAddress} ${INAYA_TOKEN_ADDRESS} ${USDT_TOKEN_ADDRESS} ${STAKING_CONTRACT_ADDRESS} ${OPERATIONAL_TREASURY_ADDRESS}`
  );

  console.log(
    "\n⚠️  IMPORTANT: this vault only accrues balance if something actually sends it INAYA/USDT."
  );
  console.log(
    "Nothing in your current page.js pays into this vault yet — see the integration notes for the wiring you still need to add to handlePaygEgressFee."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
