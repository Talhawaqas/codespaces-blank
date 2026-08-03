// scripts/fund-staking-pool.js
//
// Run with: npx hardhat run scripts/fund-staking-pool.js --network bscTestnet
//
// Approves and deposits the initial reward reserve into InayaStaking,
// then sets a reward rate that spends it evenly over a chosen duration.
//
// Adjust POOL_AMOUNT_INAYA / DURATION_DAYS for testnet — you do NOT need
// to fund the full 8,000,000 INAYA on testnet; fund a small test amount
// first, confirm claims work end-to-end, then fund the real reserve.

const hre = require("hardhat");
const { ethers } = hre;

const INAYA_TOKEN_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";
const STAKING_ADDRESS = process.env.NEXT_PUBLIC_STAKING_ADDRESS || "0xYourDeployedStakingAddress";

const POOL_AMOUNT_INAYA = "1000000"; // full reserve — reduce for a testnet dry run, e.g. "10000"
const DURATION_DAYS = 365;

const erc20ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function balanceOf(address account) public view returns (uint256)"
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Funding from account:", signer.address);

  const inaya = new ethers.Contract(INAYA_TOKEN_ADDRESS, erc20ABI, signer);
  const staking = await ethers.getContractAt("InayaStaking", STAKING_ADDRESS, signer);

  const poolAmountWei = ethers.parseUnits(POOL_AMOUNT_INAYA, 18);

  const balance = await inaya.balanceOf(signer.address);
  if (balance < poolAmountWei) {
    throw new Error(
      `Deployer only holds ${ethers.formatUnits(balance, 18)} INAYA, need ${POOL_AMOUNT_INAYA}. Use the faucet or mint more test tokens first.`
    );
  }

  console.log(`Approving staking contract to pull ${POOL_AMOUNT_INAYA} INAYA...`);
  const approveTx = await inaya.approve(STAKING_ADDRESS, poolAmountWei);
  await approveTx.wait();
  console.log("✅ Approved.");

  console.log(`Funding reward pool with ${POOL_AMOUNT_INAYA} INAYA...`);
  const fundTx = await staking.fundRewardPool(poolAmountWei);
  await fundTx.wait();
  console.log("✅ Reward pool funded. Tx:", fundTx.hash);

  const rewardRate = poolAmountWei / BigInt(DURATION_DAYS * 24 * 60 * 60);
  console.log(`Setting reward rate to spend the pool over ${DURATION_DAYS} days (${rewardRate.toString()} wei/sec)...`);
  const rateTx = await staking.setRewardRate(rewardRate, DURATION_DAYS);
  await rateTx.wait();
  console.log("✅ Reward rate set. Tx:", rateTx.hash);

  console.log("\n🎯 Staking pool is live and emitting rewards.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
