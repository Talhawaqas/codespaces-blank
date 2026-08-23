import hre from "hardhat";

// Deploys InayaVotingPower + InayaGovernor + a TimelockController wiring them
// together. THIS SCRIPT IS NOT MEANT TO BE RUN YET -- see the SCOPE NOTEs in
// contracts/governance/InayaVotingPower.sol and InayaGovernor.sol. The charter's
// Phase 2 trigger (sustained quorum across Phase 1 Snapshot votes + an
// independent security audit of these very contracts) has not happened.
// This script exists so the deployment procedure is fully specified and
// reviewable ahead of time, same as every other deploy script in this repo.
//
// STAKING_ADDRESS must point at the real, already-deployed InayaStaking
// contract (NEXT_PUBLIC_STAKING_ADDRESS in .env.local) -- InayaVotingPower
// mirrors that contract's stake+multiplier state, it does not re-implement it.
//
// Timelock delay is 36 hours (129600 seconds) to match the SAME delay
// InayaNodeRegistry's settlement flow already uses -- see Article IV of the
// governance charter ("reusing a real, deployed timelock pattern rather than
// inventing a new delay period").
//
// Governance parameters below (voting delay/period, proposal threshold,
// quorum) are starting defaults grounded in common OZ Governor practice, NOT
// something this script should silently finalize -- confirm them against the
// charter and your own risk tolerance before ever deploying for real.

const TIMELOCK_DELAY_SECONDS = 36 * 60 * 60; // 36 hours, matches InayaNodeRegistry.SETTLEMENT_DELAY
const VOTING_DELAY_BLOCKS = 7200; // ~1 day at ~12s/block (BSC is faster than this; treat as a starting point, not a measured constant)
const VOTING_PERIOD_BLOCKS = 50400; // ~1 week, same basis as above
const PROPOSAL_THRESHOLD = 0n; // no minimum voting-power to propose -- reconsider once real weight is live
const QUORUM_PERCENT = 4n; // 4% of total InayaVotingPower supply, OZ wizard's common default

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const stakingAddress = process.env.NEXT_PUBLIC_STAKING_ADDRESS;
  if (!stakingAddress) {
    throw new Error("NEXT_PUBLIC_STAKING_ADDRESS is not set -- InayaVotingPower must point at the real, already-deployed InayaStaking contract.");
  }
  console.log("Mirroring stake weight from InayaStaking at:", stakingAddress);

  // 1. Voting power mirror.
  const VotingPower = await hre.ethers.getContractFactory("InayaVotingPower");
  const votingPower = await VotingPower.deploy(stakingAddress);
  await votingPower.waitForDeployment();
  const votingPowerAddress = await votingPower.getAddress();
  console.log("InayaVotingPower deployed to:", votingPowerAddress);

  // 2. Timelock. Deployer is temporary admin so it can grant PROPOSER_ROLE /
  //    CANCELLER_ROLE to the Governor below -- renounce that admin role once
  //    wiring is confirmed (see the printed reminder at the end), so the
  //    timelock ends up self-administered by governance, not by a single key.
  //    executors: [ethers.ZeroAddress] means anyone can execute once a
  //    proposal clears its delay -- execution itself isn't a privileged step,
  //    passing the vote + clearing the timelock already is.
  const Timelock = await hre.ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(TIMELOCK_DELAY_SECONDS, [], [hre.ethers.ZeroAddress], deployer.address);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("TimelockController deployed to:", timelockAddress, "(36h delay, deployer is temporary admin)");

  // 3. Governor, wired to both.
  const Governor = await hre.ethers.getContractFactory("InayaGovernor");
  const governor = await Governor.deploy(
    votingPowerAddress,
    timelockAddress,
    VOTING_DELAY_BLOCKS,
    VOTING_PERIOD_BLOCKS,
    PROPOSAL_THRESHOLD,
    QUORUM_PERCENT
  );
  await governor.waitForDeployment();
  const governorAddress = await governor.getAddress();
  console.log("InayaGovernor deployed to:", governorAddress);

  // 4. Grant the Governor the roles it needs on the timelock.
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  await (await timelock.grantRole(PROPOSER_ROLE, governorAddress)).wait();
  await (await timelock.grantRole(CANCELLER_ROLE, governorAddress)).wait();
  console.log("Granted PROPOSER_ROLE and CANCELLER_ROLE to the Governor on the timelock.");

  console.log("\n=== Save these to your env (backend + client config) ===");
  console.log("NEXT_PUBLIC_VOTING_POWER_ADDRESS =", votingPowerAddress);
  console.log("NEXT_PUBLIC_GOVERNANCE_TIMELOCK_ADDRESS =", timelockAddress);
  console.log("NEXT_PUBLIC_GOVERNOR_ADDRESS =", governorAddress);
  console.log("===========================================================\n");

  console.log("Verify on BscScan:");
  console.log(`npx hardhat verify --network bscTestnet ${votingPowerAddress} ${stakingAddress}`);
  console.log(`npx hardhat verify --network bscTestnet ${timelockAddress} ${TIMELOCK_DELAY_SECONDS} "[]" "[\\"${hre.ethers.ZeroAddress}\\"]" ${deployer.address}`);
  console.log(
    `npx hardhat verify --network bscTestnet ${governorAddress} ${votingPowerAddress} ${timelockAddress} ${VOTING_DELAY_BLOCKS} ${VOTING_PERIOD_BLOCKS} ${PROPOSAL_THRESHOLD} ${QUORUM_PERCENT}`
  );

  console.log("\n=== REQUIRED follow-up before this is real governance, not just deployed code ===");
  console.log("1. Renounce the deployer's DEFAULT_ADMIN_ROLE on the timelock:");
  console.log(`   timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), "${deployer.address}")`);
  console.log("   Skipping this leaves a single EOA able to bypass the Governor entirely.");
  console.log("2. Stakers must call InayaVotingPower.sync(their address) and then delegate()");
  console.log("   (usually to themselves) before their stake counts as voting weight -- neither");
  console.log("   happens automatically, by ERC20Votes design.");
  console.log("3. This is Phase 2 of the governance charter. Confirm the charter's Phase 2 trigger");
  console.log("   (sustained Phase 1 quorum + independent security audit) has actually happened");
  console.log("   before treating any of this as binding on real funds or real contract ownership.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
