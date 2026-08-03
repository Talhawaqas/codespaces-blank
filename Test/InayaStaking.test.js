// test/InayaStaking.test.js
//
// Run with: npx hardhat test test/InayaStaking.test.js
//
// Covers: staking, lockup enforcement, reward accrual + multipliers,
// claiming, exit, admin functions, and access control.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const ONE_DAY = 24 * 60 * 60;
const ONE_INAYA = ethers.parseUnits("1", 18);

async function increaseTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");
}

describe("InayaStaking", function () {
  let staking, inaya, owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    // Simple mintable ERC-20 stand-in for $INAYA in tests
    const MockERC20 = await ethers.getContractFactory("MockINAYA");
    inaya = await MockERC20.deploy();
    await inaya.waitForDeployment();

    const Staking = await ethers.getContractFactory("InayaStaking");
    staking = await Staking.deploy(await inaya.getAddress(), await inaya.getAddress());
    await staking.waitForDeployment();

    // Fund owner, alice, bob with test INAYA
    await inaya.mint(owner.address, ethers.parseUnits("10000000", 18));
    await inaya.mint(alice.address, ethers.parseUnits("100000", 18));
    await inaya.mint(bob.address, ethers.parseUnits("100000", 18));

    // Fund the reward pool: 8,000,000 INAYA over 365 days
    const poolAmount = ethers.parseUnits("8000000", 18);
    await inaya.connect(owner).approve(await staking.getAddress(), poolAmount);
    await staking.connect(owner).fundRewardPool(poolAmount);

    const rewardRate = poolAmount / BigInt(365 * ONE_DAY);
    await staking.connect(owner).setRewardRate(rewardRate, 365);
  });

  describe("Staking", function () {
    it("stakes flexible (0-day) tokens and updates totalStaked", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await expect(staking.connect(alice).stake(amount, 0))
        .to.emit(staking, "Staked")
        .withArgs(alice.address, amount, 0);

      expect(await staking.totalStaked()).to.equal(amount);
      expect(await staking.userStakedBalance(alice.address)).to.equal(amount);
    });

    it("rejects an invalid lock period", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await expect(staking.connect(alice).stake(amount, 45)).to.be.revertedWith(
        "Invalid lock period: use 0, 30, or 90"
      );
    });

    it("rejects staking 0", async function () {
      await expect(staking.connect(alice).stake(0, 0)).to.be.revertedWith("Cannot stake 0");
    });

    it("sets lockExpiry correctly for a 30-day stake", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      const tx = await staking.connect(alice).stake(amount, 30);
      const block = await ethers.provider.getBlock(tx.blockNumber);

      const expiry = await staking.lockExpiry(alice.address);
      expect(expiry).to.equal(BigInt(block.timestamp) + BigInt(30 * ONE_DAY));
    });

    it("rejects topping up at a different tier than the original stake", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount * 2n);
      await staking.connect(alice).stake(amount, 30);

      await expect(staking.connect(alice).stake(amount, 90)).to.be.revertedWith(
        "Must match your existing lock tier to top up; withdraw fully to switch tiers"
      );
    });

    it("allows topping up at the same tier", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount * 2n);
      await staking.connect(alice).stake(amount, 30);
      await staking.connect(alice).stake(amount, 30);

      expect(await staking.userStakedBalance(alice.address)).to.equal(amount * 2n);
    });
  });

  describe("Withdrawals & lockups", function () {
    it("blocks withdrawal before lock expiry", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 30);

      await expect(staking.connect(alice).withdraw(amount)).to.be.revertedWith("Tokens Locked");
    });

    it("allows withdrawal after lock expiry", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 30);

      await increaseTime(31 * ONE_DAY);

      await expect(staking.connect(alice).withdraw(amount))
        .to.emit(staking, "Withdrawn")
        .withArgs(alice.address, amount);
      expect(await staking.userStakedBalance(alice.address)).to.equal(0);
    });

    it("allows immediate withdrawal for flexible (0-day) stakes", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);

      await expect(staking.connect(alice).withdraw(amount)).to.not.be.reverted;
    });

    it("resets tier state after a full exit, allowing a new tier choice", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount * 2n);
      await staking.connect(alice).stake(amount, 30);
      await increaseTime(31 * ONE_DAY);
      await staking.connect(alice).withdraw(amount);

      // Should now be free to pick a different tier (90 days) with a fresh stake
      await expect(staking.connect(alice).stake(amount, 90)).to.not.be.reverted;
    });

    it("rejects withdrawing more than staked balance", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);

      await expect(
        staking.connect(alice).withdraw(ethers.parseUnits("2000", 18))
      ).to.be.revertedWith("Insufficient staked balance");
    });
  });

  describe("Rewards", function () {
    it("accrues rewards over time for a flexible staker", async function () {
      const amount = ethers.parseUnits("10000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);

      await increaseTime(30 * ONE_DAY);

      const earned = await staking.earned(alice.address);
      expect(earned).to.be.gt(0);
    });

    it("gives a 90-day locker more rewards than a flexible staker for the same amount/time", async function () {
      const amount = ethers.parseUnits("10000", 18);

      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0); // flexible

      await inaya.connect(bob).approve(await staking.getAddress(), amount);
      await staking.connect(bob).stake(amount, 90); // boosted

      await increaseTime(30 * ONE_DAY);

      const aliceEarned = await staking.earned(alice.address);
      const bobEarned = await staking.earned(bob.address);

      expect(bobEarned).to.be.gt(aliceEarned);
    });

    it("lets a user claim earned rewards", async function () {
      const amount = ethers.parseUnits("10000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);

      await increaseTime(30 * ONE_DAY);

      const before = await inaya.balanceOf(alice.address);
      await expect(staking.connect(alice).claimReward()).to.emit(staking, "RewardPaid");
      const after = await inaya.balanceOf(alice.address);

      expect(after).to.be.gt(before);
      expect(await staking.rewards(alice.address)).to.equal(0);
    });

    it("rejects claiming with zero pending rewards", async function () {
      await expect(staking.connect(alice).claimReward()).to.be.revertedWith("No rewards to claim");
    });

    it("reverts claim if the tracked reward pool is exhausted", async function () {
      // Drain the pool via a very high reward rate over a short window, then try to claim more than exists
      const Staking2 = await ethers.getContractFactory("InayaStaking");
      const staking2 = await Staking2.deploy(await inaya.getAddress(), await inaya.getAddress());
      await staking2.waitForDeployment();

      const tinyPool = ethers.parseUnits("100", 18);
      await inaya.connect(owner).approve(await staking2.getAddress(), tinyPool);
      await staking2.connect(owner).fundRewardPool(tinyPool);
      // Rate deliberately far too high for the funded pool
      await staking2.connect(owner).setRewardRate(ethers.parseUnits("1000", 18), 1);

      const amount = ethers.parseUnits("10", 18);
      await inaya.connect(alice).approve(await staking2.getAddress(), amount);
      await staking2.connect(alice).stake(amount, 0);

      await increaseTime(2 * ONE_DAY);

      await expect(staking2.connect(alice).claimReward()).to.be.revertedWith(
  "Reward pool underfunded - ask admin to fundRewardPool()"
);
    });
  });

  describe("exit()", function () {
    it("withdraws stake and claims rewards in one call", async function () {
      const amount = ethers.parseUnits("10000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);

      await increaseTime(10 * ONE_DAY);

      const before = await inaya.balanceOf(alice.address);
      await staking.connect(alice).exit();
      const after = await inaya.balanceOf(alice.address);

      expect(await staking.userStakedBalance(alice.address)).to.equal(0);
      expect(after).to.be.gt(before);
    });
  });

  describe("Tiers", function () {
    it("reports None / Standard / Enterprise Priority correctly", async function () {
      expect(await staking.getUserTier(alice.address)).to.equal("None");

      const standardAmount = ethers.parseUnits("1000", 18);
      await inaya.connect(alice).approve(await staking.getAddress(), standardAmount);
      await staking.connect(alice).stake(standardAmount, 0);
      expect(await staking.getUserTier(alice.address)).to.equal("Standard");

      const enterpriseAmount = ethers.parseUnits("60000", 18);
      await inaya.connect(bob).approve(await staking.getAddress(), enterpriseAmount);
      await staking.connect(bob).stake(enterpriseAmount, 0);
      expect(await staking.getUserTier(bob.address)).to.equal("Enterprise Priority");
    });
  });

  describe("Admin functions & access control", function () {
    it("rejects setRewardRate from a non-owner", async function () {
      await expect(
        staking.connect(alice).setRewardRate(1, 30)
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    });

    it("rejects fundRewardPool from a non-owner", async function () {
      await expect(
        staking.connect(alice).fundRewardPool(ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    });

    it("rejects setEnterpriseTierThreshold from a non-owner", async function () {
      await expect(
        staking.connect(alice).setEnterpriseTierThreshold(1)
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    });

    it("updates the enterprise tier threshold", async function () {
      await staking.connect(owner).setEnterpriseTierThreshold(ethers.parseUnits("1000", 18));
      expect(await staking.enterpriseTierThreshold()).to.equal(ethers.parseUnits("1000", 18));
    });

    it("rejects recovering the staking/reward token itself", async function () {
      await expect(
        staking.connect(owner).recoverForeignToken(await inaya.getAddress(), 1)
      ).to.be.revertedWith("Cannot recover the staking/reward token");
    });
  });
});
