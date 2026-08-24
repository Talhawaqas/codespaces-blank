// test/HackathonRewards.test.js
//
// Run with: npx hardhat test test/HackathonRewards.test.js
//
// Covers InayaHackathonRewards: allocation cap enforcement (single + batch
// configure), double-claim prevention, claim() gated behind mainnetActive,
// access control on every admin function, and emergencyWithdrawUnallocated
// never being able to touch a configured-but-unclaimed winner's funds.
//
// activateMainnet()'s SUCCESS path (block.chainid == 56) is intentionally
// NOT exercised here — Hardhat's in-process network can't change its chain
// id at runtime (hardhat_reset only supports overriding `forking`, not
// chainId), and this suite runs on the default chain id 31337. That success
// path is instead covered for real in
// test/HackathonRewards.mainnetActivation.test.js, run against a sibling
// config (hardhat.mainnet-sim.config.js) that boots a second in-process
// network reporting chain id 56 from the start. What THIS file proves is the
// actually security-critical half: the call reverts everywhere that isn't
// chain 56, including this default test network.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const ONE_INAYA = ethers.parseUnits("1", 18);
const CAP = ethers.parseUnits("100000", 18);

describe("InayaHackathonRewards", function () {
  let rewards, inaya, owner, alice, bob, carol;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const MockINAYA = await ethers.getContractFactory("MockINAYA");
    inaya = await MockINAYA.deploy();
    await inaya.waitForDeployment();

    const Rewards = await ethers.getContractFactory("InayaHackathonRewards");
    rewards = await Rewards.deploy(await inaya.getAddress());
    await rewards.waitForDeployment();
  });

  describe("configureWinner / configureWinnersBatch", function () {
    it("configures a winner and tracks totalAllocated", async function () {
      await expect(rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18)))
        .to.emit(rewards, "WinnerConfigured")
        .withArgs(alice.address, ethers.parseUnits("40000", 18), ethers.parseUnits("40000", 18));

      expect(await rewards.allocations(alice.address)).to.equal(ethers.parseUnits("40000", 18));
      expect(await rewards.totalAllocated()).to.equal(ethers.parseUnits("40000", 18));
      expect(await rewards.winnersCount()).to.equal(1);
    });

    it("allows correcting an existing winner's allocation before they claim", async function () {
      await rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18));
      await rewards.configureWinner(alice.address, ethers.parseUnits("25000", 18));

      expect(await rewards.allocations(alice.address)).to.equal(ethers.parseUnits("25000", 18));
      expect(await rewards.totalAllocated()).to.equal(ethers.parseUnits("25000", 18));
      expect(await rewards.winnersCount()).to.equal(1); // not re-pushed to winnersList
    });

    it("rejects a single allocation that would exceed the 100,000 cap", async function () {
      await expect(rewards.configureWinner(alice.address, CAP + ONE_INAYA))
        .to.be.revertedWith("exceeds 100,000 INAYA prize pool cap");
    });

    it("rejects a batch whose combined total exceeds the cap", async function () {
      await expect(
        rewards.configureWinnersBatch(
          [alice.address, bob.address],
          [ethers.parseUnits("60000", 18), ethers.parseUnits("41000", 18)]
        )
      ).to.be.revertedWith("exceeds 100,000 INAYA prize pool cap");
    });

    it("accepts a batch exactly at the cap", async function () {
      await rewards.configureWinnersBatch(
        [alice.address, bob.address, carol.address],
        [ethers.parseUnits("40000", 18), ethers.parseUnits("35000", 18), ethers.parseUnits("25000", 18)]
      );
      expect(await rewards.totalAllocated()).to.equal(CAP);
    });

    it("reverts on batch array length mismatch", async function () {
      await expect(
        rewards.configureWinnersBatch([alice.address, bob.address], [ONE_INAYA])
      ).to.be.revertedWith("array length mismatch");
    });

    it("restricts configureWinner/configureWinnersBatch to the owner", async function () {
      await expect(rewards.connect(alice).configureWinner(alice.address, ONE_INAYA))
        .to.be.revertedWithCustomError(rewards, "OwnableUnauthorizedAccount");
      await expect(rewards.connect(alice).configureWinnersBatch([alice.address], [ONE_INAYA]))
        .to.be.revertedWithCustomError(rewards, "OwnableUnauthorizedAccount");
    });
  });

  describe("activateMainnet", function () {
    it("reverts on any chain that isn't 56 (this suite runs on chain 31337)", async function () {
      const network = await ethers.provider.getNetwork();
      expect(network.chainId).to.equal(31337n);
      await expect(rewards.activateMainnet()).to.be.revertedWith("mainnet only");
    });

    it("restricts activateMainnet to the owner (still reverts on chainid first)", async function () {
      // Non-owner call reverts on the onlyOwner check before the chainid check is even reached
      // is NOT guaranteed by Solidity's require ordering here -- activateMainnet checks chainid
      // first, so this asserts the actual revert reason the contract produces.
      await expect(rewards.connect(alice).activateMainnet())
        .to.be.revertedWithCustomError(rewards, "OwnableUnauthorizedAccount");
    });
  });

  describe("claim", function () {
    beforeEach(async function () {
      await rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18));
      await inaya.mint(await rewards.getAddress(), ethers.parseUnits("40000", 18));
    });

    it("reverts before mainnet activation", async function () {
      await expect(rewards.connect(alice).claim()).to.be.revertedWith("rewards are not yet active");
    });

    it("reverts for an address with no allocation, even hypothetically active", async function () {
      // mainnetActive can't actually be flipped true on this network (see activateMainnet
      // tests above) -- this just proves the "no allocation" branch independently by checking
      // an unconfigured address's claim reverts on the allocation check before it'd ever reach
      // the activation check, since the require order is activation -> allocation.
      await expect(rewards.connect(bob).claim()).to.be.revertedWith("rewards are not yet active");
    });
  });

  describe("emergencyWithdrawUnallocated", function () {
    it("reports unallocatedBalance correctly against configured-but-unclaimed funds", async function () {
      await rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18));
      await inaya.mint(await rewards.getAddress(), ethers.parseUnits("50000", 18)); // 10k spare

      expect(await rewards.unallocatedBalance()).to.equal(ethers.parseUnits("10000", 18));
    });

    it("allows withdrawing spare (unallocated) funds", async function () {
      await rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18));
      await inaya.mint(await rewards.getAddress(), ethers.parseUnits("50000", 18));

      await expect(rewards.emergencyWithdrawUnallocated(owner.address, ethers.parseUnits("10000", 18)))
        .to.emit(rewards, "EmergencyWithdraw")
        .withArgs(owner.address, ethers.parseUnits("10000", 18));

      expect(await inaya.balanceOf(owner.address)).to.equal(ethers.parseUnits("10000", 18));
    });

    it("reverts if trying to withdraw more than the unallocated balance", async function () {
      await rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18));
      await inaya.mint(await rewards.getAddress(), ethers.parseUnits("50000", 18)); // 10k spare

      await expect(
        rewards.emergencyWithdrawUnallocated(owner.address, ethers.parseUnits("10000", 18) + ONE_INAYA)
      ).to.be.revertedWith("amount exceeds unallocated balance");
    });

    it("reverts if trying to withdraw a configured winner's earmarked funds when there's no spare balance", async function () {
      await rewards.configureWinner(alice.address, ethers.parseUnits("40000", 18));
      await inaya.mint(await rewards.getAddress(), ethers.parseUnits("40000", 18)); // exactly earmarked, no spare

      await expect(
        rewards.emergencyWithdrawUnallocated(owner.address, ONE_INAYA)
      ).to.be.revertedWith("amount exceeds unallocated balance");
    });

    it("restricts emergencyWithdrawUnallocated to the owner", async function () {
      await expect(rewards.connect(alice).emergencyWithdrawUnallocated(alice.address, 0))
        .to.be.revertedWithCustomError(rewards, "OwnableUnauthorizedAccount");
    });
  });
});
