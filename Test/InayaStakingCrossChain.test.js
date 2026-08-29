// Test/InayaStakingCrossChain.test.js
//
// Run with: npx hardhat test Test/InayaStakingCrossChain.test.js
//
// Covers the new stakeFor/withdrawTo/claimRewardTo cross-chain entry points added to
// InayaStaking.sol. Test/InayaStaking.test.js (unmodified) already re-runs against this same
// extended contract as the regression gate proving stake/withdraw/claimReward/exit are
// byte-for-byte unchanged -- this file only covers the additions.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const ONE_DAY = 24 * 60 * 60;
const ONE_INAYA = ethers.parseUnits("1", 18);
const SEPOLIA = 11155111;
const AMOY = 80002;

async function increaseTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");
}

describe("InayaStaking -- cross-chain extensions", function () {
  let staking, inaya, gatewayMock, bridgePlaceholder;
  let owner, alice, bob, gatewayEOA, homeChainId;

  beforeEach(async function () {
    [owner, alice, bob, gatewayEOA, bridgePlaceholder] = await ethers.getSigners();
    homeChainId = (await ethers.provider.getNetwork()).chainId;

    const MockERC20 = await ethers.getContractFactory("MockINAYA");
    inaya = await MockERC20.deploy();
    await inaya.waitForDeployment();

    const Staking = await ethers.getContractFactory("InayaStaking");
    staking = await Staking.deploy(await inaya.getAddress(), await inaya.getAddress());
    await staking.waitForDeployment();

    const GatewayMock = await ethers.getContractFactory("MockStakingGatewayHome");
    gatewayMock = await GatewayMock.deploy(bridgePlaceholder.address);
    await gatewayMock.waitForDeployment();

    await staking.setCrossChainGateway(await gatewayMock.getAddress());

    // Fund the reward pool so withdraw/claim paths that also accrue rewards have something real
    // to draw from.
    const poolAmount = ethers.parseUnits("8000000", 18);
    await inaya.mint(owner.address, poolAmount);
    await inaya.connect(owner).approve(await staking.getAddress(), poolAmount);
    await staking.connect(owner).fundRewardPool(poolAmount);
    const rewardRate = poolAmount / BigInt(365 * ONE_DAY);
    await staking.connect(owner).setRewardRate(rewardRate, 365);
  });

  describe("stakeFor", function () {
    it("rejects a caller that isn't the configured gateway", async function () {
      await inaya.mint(alice.address, ONE_INAYA);
      await inaya.connect(alice).approve(await staking.getAddress(), ONE_INAYA);
      await expect(staking.connect(alice).stakeFor(alice.address, ONE_INAYA, 0, SEPOLIA)).to.be.revertedWith(
        "Caller is not the cross-chain gateway"
      );
    });

    it("credits the user's position exactly like a same-chain stake, pulling tokens from the gateway", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.mint(gatewayEOA.address, amount);
      await inaya.connect(gatewayEOA).approve(await staking.getAddress(), amount);
      await staking.setCrossChainGateway(gatewayEOA.address);

      await expect(staking.connect(gatewayEOA).stakeFor(alice.address, amount, 30, SEPOLIA))
        .to.emit(staking, "Staked")
        .withArgs(alice.address, amount, 30)
        .and.to.emit(staking, "StakedCrossChain")
        .withArgs(alice.address, amount, 30, SEPOLIA);

      expect(await staking.userStakedBalance(alice.address)).to.equal(amount);
      expect(await staking.totalStaked()).to.equal(amount);
      expect(await staking.userStakedByChain(alice.address, SEPOLIA)).to.equal(amount);
      // Tokens came from the gateway's balance, not alice's.
      expect(await inaya.balanceOf(gatewayEOA.address)).to.equal(0);
    });

    it("accumulates userStakedByChain across multiple origin chains without touching reward math", async function () {
      const amount1 = ethers.parseUnits("500", 18);
      const amount2 = ethers.parseUnits("300", 18);
      await inaya.mint(gatewayEOA.address, amount1 + amount2);
      await inaya.connect(gatewayEOA).approve(await staking.getAddress(), amount1 + amount2);
      await staking.setCrossChainGateway(gatewayEOA.address);

      await staking.connect(gatewayEOA).stakeFor(alice.address, amount1, 0, SEPOLIA);
      await staking.connect(gatewayEOA).stakeFor(alice.address, amount2, 0, AMOY);

      expect(await staking.userStakedByChain(alice.address, SEPOLIA)).to.equal(amount1);
      expect(await staking.userStakedByChain(alice.address, AMOY)).to.equal(amount2);
      expect(await staking.userStakedBalance(alice.address)).to.equal(amount1 + amount2); // merged, single position
    });

    it("enforces the same lock-tier consistency rule as stake()", async function () {
      const amount = ethers.parseUnits("100", 18);
      await inaya.mint(gatewayEOA.address, amount * 2n);
      await inaya.connect(gatewayEOA).approve(await staking.getAddress(), amount * 2n);
      await staking.setCrossChainGateway(gatewayEOA.address);

      await staking.connect(gatewayEOA).stakeFor(alice.address, amount, 30, SEPOLIA);
      await expect(staking.connect(gatewayEOA).stakeFor(alice.address, amount, 90, SEPOLIA)).to.be.revertedWith(
        "Must match your existing lock tier to top up; withdraw fully to switch tiers"
      );
    });

    it("respects pauseCrossChain -- stakeFor blocked, stake() unaffected", async function () {
      await inaya.mint(gatewayEOA.address, ONE_INAYA);
      await inaya.connect(gatewayEOA).approve(await staking.getAddress(), ONE_INAYA);
      await staking.setCrossChainGateway(gatewayEOA.address);
      await staking.pauseCrossChain();

      await expect(staking.connect(gatewayEOA).stakeFor(alice.address, ONE_INAYA, 0, SEPOLIA)).to.be.revertedWithCustomError(
        staking,
        "EnforcedPause"
      );

      await inaya.mint(bob.address, ONE_INAYA);
      await inaya.connect(bob).approve(await staking.getAddress(), ONE_INAYA);
      await expect(staking.connect(bob).stake(ONE_INAYA, 0)).to.not.be.reverted; // local staking unaffected
    });
  });

  describe("withdrawTo", function () {
    beforeEach(async function () {
      const amount = ethers.parseUnits("1000", 18);
      await inaya.mint(alice.address, amount);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0); // flexible, locally staked
    });

    it("rejects targeting the home chain itself", async function () {
      await expect(staking.connect(alice).withdrawTo(ONE_INAYA, homeChainId, ethers.zeroPadValue(alice.address, 32))).to.be.revertedWith(
        "Use withdraw() for the home chain"
      );
    });

    it("debits the position and forwards through the gateway/bridge with the right args", async function () {
      const amount = ethers.parseUnits("400", 18);
      const destRecipient = ethers.zeroPadValue(bob.address, 32);

      await expect(staking.connect(alice).withdrawTo(amount, SEPOLIA, destRecipient))
        .to.emit(staking, "WithdrawnCrossChain")
        .withArgs(alice.address, amount, SEPOLIA, destRecipient, await gatewayMock.FIXED_MESSAGE_ID());

      expect(await staking.userStakedBalance(alice.address)).to.equal(ethers.parseUnits("600", 18));
      expect(await gatewayMock.forwardWithdrawalCallCount()).to.equal(1);
      expect(await gatewayMock.lastAmount()).to.equal(amount);
      expect(await gatewayMock.lastDestChainId()).to.equal(SEPOLIA);
      expect(await gatewayMock.lastDestRecipient()).to.equal(destRecipient);
      // Staking approved the bridge (not the gateway mock itself) for `amount` plus the small
      // fixed fee margin (see InayaStaking.sol's CROSS_CHAIN_FEE_MARGIN).
      expect(await inaya.allowance(await staking.getAddress(), bridgePlaceholder.address)).to.equal(
        amount + ethers.parseUnits("0.001", 18)
      );
    });

    it("rejects withdrawing more than staked, same as withdraw()", async function () {
      await expect(
        staking.connect(alice).withdrawTo(ethers.parseUnits("5000", 18), SEPOLIA, ethers.zeroPadValue(bob.address, 32))
      ).to.be.revertedWith("Insufficient staked balance");
    });

    it("respects lock expiry, same as withdraw()", async function () {
      const amount = ethers.parseUnits("100", 18);
      await inaya.mint(bob.address, amount);
      await inaya.connect(bob).approve(await staking.getAddress(), amount);
      await staking.connect(bob).stake(amount, 30);

      await expect(
        staking.connect(bob).withdrawTo(amount, SEPOLIA, ethers.zeroPadValue(bob.address, 32))
      ).to.be.revertedWith("Tokens Locked");
    });

    it("respects pauseCrossChain -- withdrawTo blocked, withdraw() unaffected", async function () {
      await staking.pauseCrossChain();
      await expect(
        staking.connect(alice).withdrawTo(ONE_INAYA, SEPOLIA, ethers.zeroPadValue(bob.address, 32))
      ).to.be.revertedWithCustomError(staking, "EnforcedPause");

      await expect(staking.connect(alice).withdraw(ONE_INAYA)).to.not.be.reverted;
    });
  });

  describe("claimRewardTo", function () {
    beforeEach(async function () {
      const amount = ethers.parseUnits("10000", 18);
      await inaya.mint(alice.address, amount);
      await inaya.connect(alice).approve(await staking.getAddress(), amount);
      await staking.connect(alice).stake(amount, 0);
      await increaseTime(30 * ONE_DAY);
    });

    it("rejects targeting the home chain itself", async function () {
      await expect(staking.connect(alice).claimRewardTo(homeChainId, ethers.zeroPadValue(alice.address, 32))).to.be.revertedWith(
        "Use claimReward() for the home chain"
      );
    });

    it("zeroes the reward before forwarding, so it can never double-pay", async function () {
      const destRecipient = ethers.zeroPadValue(bob.address, 32);
      const earnedBefore = await staking.earned(alice.address);
      expect(earnedBefore).to.be.gt(0);

      await expect(staking.connect(alice).claimRewardTo(SEPOLIA, destRecipient)).to.emit(staking, "RewardPaidCrossChain");

      // rewards[] is zeroed in the same call, before the cross-chain forward -- proof a retried/
      // replayed message can never see this same reward again. (A follow-up claim can still
      // succeed for whatever NEW reward has accrued in the meantime; that's not a double-pay.)
      expect(await staking.rewards(alice.address)).to.equal(0);
      expect(await gatewayMock.forwardClaimCallCount()).to.equal(1);
      expect(await gatewayMock.lastDestChainId()).to.equal(SEPOLIA);
      expect(await gatewayMock.lastAmount()).to.be.gte(earnedBefore);
    });

    it("rejects when the tracked reward pool is underfunded, same guard as claimReward()", async function () {
      // Drain the pool via a fresh staking deployment with a tiny pool and a too-high rate.
      const Staking2 = await ethers.getContractFactory("InayaStaking");
      const staking2 = await Staking2.deploy(await inaya.getAddress(), await inaya.getAddress());
      await staking2.waitForDeployment();
      await staking2.setCrossChainGateway(await gatewayMock.getAddress());

      const tinyPool = ethers.parseUnits("100", 18);
      await inaya.mint(owner.address, tinyPool);
      await inaya.connect(owner).approve(await staking2.getAddress(), tinyPool);
      await staking2.connect(owner).fundRewardPool(tinyPool);
      await staking2.connect(owner).setRewardRate(ethers.parseUnits("1000", 18), 1);

      await inaya.mint(bob.address, ONE_INAYA * 10n);
      await inaya.connect(bob).approve(await staking2.getAddress(), ONE_INAYA * 10n);
      await staking2.connect(bob).stake(ONE_INAYA * 10n, 0);
      await increaseTime(2 * ONE_DAY);

      await expect(
        staking2.connect(bob).claimRewardTo(SEPOLIA, ethers.zeroPadValue(bob.address, 32))
      ).to.be.revertedWith("Reward pool underfunded - ask admin to fundRewardPool()");
    });

    it("respects pauseCrossChain -- claimRewardTo blocked, claimReward() unaffected", async function () {
      await staking.pauseCrossChain();
      await expect(
        staking.connect(alice).claimRewardTo(SEPOLIA, ethers.zeroPadValue(bob.address, 32))
      ).to.be.revertedWithCustomError(staking, "EnforcedPause");

      await staking.unpauseCrossChain();
      await expect(staking.connect(alice).claimReward()).to.not.be.reverted;
    });
  });

  describe("Admin", function () {
    it("restricts setCrossChainGateway/setEmergencyPauser/pauseCrossChain/unpauseCrossChain appropriately", async function () {
      await expect(staking.connect(alice).setCrossChainGateway(alice.address)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(alice).setEmergencyPauser(alice.address)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(alice).pauseCrossChain()).to.be.revertedWith("Not authorized to pause");
      await expect(staking.connect(alice).unpauseCrossChain()).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );

      await staking.setEmergencyPauser(alice.address);
      await expect(staking.connect(alice).pauseCrossChain()).to.not.be.reverted; // designated pauser, not owner
    });
  });
});
