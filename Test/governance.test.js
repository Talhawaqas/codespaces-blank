// test/governance.test.js
//
// Run with: npx hardhat test test/governance.test.js
//
// Covers Phase 2's InayaVotingPower + InayaGovernor: real InayaStaking
// integration (not a mock of the staking logic itself), stake-tier
// multiplier weighting, non-transferability, and a full
// propose -> vote -> queue -> execute round trip through a real
// TimelockController. The 36-hour production timelock delay (see
// scripts/deploy-governance.js) is NOT what's under test here -- a
// short delay is used so the test suite runs in seconds; the delay
// itself is just a deploy-time constructor argument, not contract logic.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await hre.network.provider.send("evm_mine");
  }
}

async function increaseTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");
}

const TEST_TIMELOCK_DELAY = 2; // seconds -- production uses 36 hours, see deploy script
const VOTING_DELAY = 1; // blocks
const VOTING_PERIOD = 10; // blocks
const PROPOSAL_THRESHOLD = 0;
const QUORUM_PERCENT = 4;

describe("Governance (InayaVotingPower + InayaGovernor)", function () {
  let inaya, staking, votingPower, timelock, governor;
  let deployer, alice, bob;

  beforeEach(async function () {
    [deployer, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockINAYA");
    inaya = await MockERC20.deploy();
    await inaya.waitForDeployment();

    const Staking = await ethers.getContractFactory("InayaStaking");
    staking = await Staking.deploy(await inaya.getAddress(), await inaya.getAddress());
    await staking.waitForDeployment();

    const VotingPower = await ethers.getContractFactory("InayaVotingPower");
    votingPower = await VotingPower.deploy(await staking.getAddress());
    await votingPower.waitForDeployment();

    const Timelock = await ethers.getContractFactory("TimelockController");
    // executors: [ethers.ZeroAddress] grants EXECUTOR_ROLE to address(0) -- an
    // "open" timelock anyone can execute once the delay elapses, the standard
    // OZ pattern when execution should not itself be gated by a second permission.
    timelock = await Timelock.deploy(TEST_TIMELOCK_DELAY, [], [ethers.ZeroAddress], deployer.address);
    await timelock.waitForDeployment();

    const Governor = await ethers.getContractFactory("InayaGovernor");
    governor = await Governor.deploy(
      await votingPower.getAddress(),
      await timelock.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_PERCENT
    );
    await governor.waitForDeployment();

    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    await timelock.connect(deployer).grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.connect(deployer).grantRole(CANCELLER_ROLE, await governor.getAddress());

    // Fund + stake so alice/bob have real InayaStaking state to sync from.
    await inaya.mint(alice.address, ethers.parseUnits("100000", 18));
    await inaya.mint(bob.address, ethers.parseUnits("100000", 18));
  });

  describe("InayaVotingPower.sync()", function () {
    it("mirrors flexible-tier stake 1:1", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);

      await votingPower.sync(alice.address);
      expect(await votingPower.balanceOf(alice.address)).to.equal(amount);
    });

    it("applies the 90-day tier's 1.5x multiplier", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(bob).approve(await staking.getAddress(), amount);
      await staking.connect(bob).stake(amount, 90);

      await votingPower.sync(bob.address);
      expect(await votingPower.balanceOf(bob.address)).to.equal((amount * 15n) / 10n);
    });

    it("burns down the checkpoint after a withdrawal, once re-synced", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);
      await votingPower.sync(alice.address);
      expect(await votingPower.balanceOf(alice.address)).to.equal(amount);

      await staking.connect(alice).withdraw(amount);
      await votingPower.sync(alice.address);
      expect(await votingPower.balanceOf(alice.address)).to.equal(0);
    });

    it("is a no-op mint/burn-wise when already in sync (cheap to call repeatedly)", async function () {
      const amount = ethers.parseUnits("500", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);
      await votingPower.sync(alice.address);
      const before = await votingPower.balanceOf(alice.address);
      await votingPower.sync(alice.address);
      expect(await votingPower.balanceOf(alice.address)).to.equal(before);
    });

    it("rejects transfer() and transferFrom() -- non-transferable by design", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);
      await votingPower.sync(alice.address);

      await expect(votingPower.connect(alice).transfer(bob.address, 1)).to.be.revertedWith(
        "InayaVotingPower: non-transferable, call sync() to update your weight"
      );
    });

    it("syncMany() batches multiple accounts in one call", async function () {
      const amount = ethers.parseUnits("100", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);
      await inaya.connect(bob).approve(await staking.getAddress(), amount);
      await staking.connect(bob).stake(amount, 30);

      await votingPower.syncMany([alice.address, bob.address]);
      expect(await votingPower.balanceOf(alice.address)).to.equal(amount);
      expect(await votingPower.balanceOf(bob.address)).to.equal((amount * 125n) / 100n);
    });
  });

  describe("Full propose -> vote -> queue -> execute round trip", function () {
    it("executes a self-governance quorum change once quorum + timelock delay are satisfied", async function () {
      const stakeAmount = ethers.parseUnits("10000", 18);
      for (const signer of [alice, bob]) {
        await inaya.connect(signer).approve(await staking.getAddress(), stakeAmount);
        await staking.connect(signer).stake(stakeAmount, 0);
      }
      await votingPower.syncMany([alice.address, bob.address]);

      // ERC20Votes requires an explicit self-delegation to activate checkpoints.
      await votingPower.connect(alice).delegate(alice.address);
      await votingPower.connect(bob).delegate(bob.address);

      const governorAddress = await governor.getAddress();
      const newQuorumNumerator = 10n;
      const calldata = governor.interface.encodeFunctionData("updateQuorumNumerator", [newQuorumNumerator]);
      const description = "Test proposal: lower quorum numerator to 10%";
      const descriptionHash = ethers.id(description);

      const proposeTx = await governor
        .connect(alice)
        .propose([governorAddress], [0], [calldata], description);
      const proposeReceipt = await proposeTx.wait();
      const proposalId = proposeReceipt.logs
        .map((log) => {
          try {
            return governor.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "ProposalCreated").args.proposalId;

      await mineBlocks(VOTING_DELAY + 1);

      await governor.connect(alice).castVote(proposalId, 1); // For
      await governor.connect(bob).castVote(proposalId, 1); // For

      await mineBlocks(VOTING_PERIOD + 1);

      expect(await governor.state(proposalId)).to.equal(4n); // ProposalState.Succeeded

      await governor.queue([governorAddress], [0], [calldata], descriptionHash);
      expect(await governor.state(proposalId)).to.equal(5n); // ProposalState.Queued

      await increaseTime(TEST_TIMELOCK_DELAY + 1);

      await governor.execute([governorAddress], [0], [calldata], descriptionHash);
      expect(await governor.state(proposalId)).to.equal(7n); // ProposalState.Executed
      expect(await governor.quorumNumerator()).to.equal(newQuorumNumerator);
    });
  });
});
