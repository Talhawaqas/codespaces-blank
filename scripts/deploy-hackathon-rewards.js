import hre from "hardhat";

// Deploys InayaHackathonRewards. THIS SCRIPT IS NOT MEANT TO BE RUN YET --
// per the SOW, hackathon rewards are distributed ONLY on Mainnet, and
// mainnet hasn't launched. Run this for real once it has, against the
// bscMainnet network added to hardhat.config.js alongside this script.
//
// INAYA_MAINNET_TOKEN_ADDRESS must point at the real, live $INAYA token on
// BSC Mainnet -- there is no testnet dry-run for this deploy, since
// activateMainnet() on the deployed contract will hard-revert on any chain
// that isn't 56 (see contracts/InayaHackathonRewards.sol), so there's
// nothing meaningful to rehearse against a mock token on testnet.
//
// After deploying, the actual reward flow is:
//   1. Read the finalized winners from the hackathon_winners MongoDB
//      collection (recorded ahead of time via POST /api/hackathon/winners --
//      see src/app/api/hackathon/winners/route.js in the dApp).
//   2. Call configureWinnersBatch(addresses, amounts) with that data.
//   3. Transfer exactly the total allocated $INAYA into the deployed
//      contract (a plain ERC-20 transfer -- this contract does not pull
//      funds itself, see the SafeERC20 usage in claim()/emergencyWithdraw).
//   4. Call activateMainnet() once, from the owner. This is one-way.
//   5. Set NEXT_PUBLIC_HACKATHON_REWARDS_ADDRESS in the dApp's env so
//      HackathonSection.js switches from DB-only display to reading the
//      real contract for allocation/claimed status and enabling the claim
//      button.

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const tokenAddress = process.env.INAYA_MAINNET_TOKEN_ADDRESS;
  if (!tokenAddress) {
    throw new Error("INAYA_MAINNET_TOKEN_ADDRESS is not set -- must point at the real, live $INAYA token on BSC Mainnet.");
  }
  console.log("Wiring to $INAYA token at:", tokenAddress);

  const Rewards = await hre.ethers.getContractFactory("InayaHackathonRewards");
  const rewards = await Rewards.deploy(tokenAddress);
  await rewards.waitForDeployment();
  const rewardsAddress = await rewards.getAddress();
  console.log("InayaHackathonRewards deployed to:", rewardsAddress);

  console.log("\n=== Save this to your env (backend + client config) ===");
  console.log("NEXT_PUBLIC_HACKATHON_REWARDS_ADDRESS =", rewardsAddress);
  console.log("=========================================================\n");

  console.log("Verify on BscScan:");
  console.log(`npx hardhat verify --network bscMainnet ${rewardsAddress} ${tokenAddress}`);

  console.log("\n=== REQUIRED follow-up before any winner can claim ===");
  console.log("1. configureWinnersBatch(addresses, amounts) from the deployer/owner wallet,");
  console.log("   sourced from the hackathon_winners collection recorded ahead of time.");
  console.log("2. Transfer the total allocated amount of real $INAYA into", rewardsAddress);
  console.log("   (a plain ERC-20 transfer -- the contract never pulls funds on its own).");
  console.log("3. activateMainnet() -- one-way, and only succeeds on chain id 56.");
  console.log("4. Set NEXT_PUBLIC_HACKATHON_REWARDS_ADDRESS so the dApp reads the live contract.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
