// test/HackathonRewards.mainnetActivation.test.js
//
// Run with: npx hardhat test test/HackathonRewards.mainnetActivation.test.js --config hardhat.mainnet-sim.config.js
//
// Exercises the ONE path test/HackathonRewards.test.js explicitly cannot:
// activateMainnet() actually succeeding, on a network that genuinely
// reports chain id 56 (see hardhat.mainnet-sim.config.js). Proves the full
// activate -> claim flow works end to end once on real mainnet.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("InayaHackathonRewards — mainnet activation (chain id 56)", function () {
  it("activates only on chain 56, then lets a configured winner claim", async function () {
    const network = await ethers.provider.getNetwork();
    expect(network.chainId).to.equal(56n);

    const [owner, alice] = await ethers.getSigners();

    const MockINAYA = await ethers.getContractFactory("MockINAYA");
    const inaya = await MockINAYA.deploy();
    await inaya.waitForDeployment();

    const Rewards = await ethers.getContractFactory("InayaHackathonRewards");
    const rewards = await Rewards.deploy(await inaya.getAddress());
    await rewards.waitForDeployment();

    const amount = ethers.parseUnits("40000", 18);
    await rewards.configureWinner(alice.address, amount);
    await inaya.mint(await rewards.getAddress(), amount);

    await expect(rewards.activateMainnet()).to.emit(rewards, "MainnetActivated");
    expect(await rewards.mainnetActive()).to.equal(true);

    // one-way: calling it again reverts, doesn't re-emit or reset anything
    await expect(rewards.activateMainnet()).to.be.revertedWith("already active");

    await expect(rewards.connect(alice).claim())
      .to.emit(rewards, "RewardClaimed")
      .withArgs(alice.address, amount);

    expect(await inaya.balanceOf(alice.address)).to.equal(amount);
    expect(await rewards.claimed(alice.address)).to.equal(true);

    await expect(rewards.connect(alice).claim()).to.be.revertedWith("already claimed");
  });
});
