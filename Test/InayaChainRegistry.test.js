// Test/InayaChainRegistry.test.js
//
// Run with: npx hardhat test Test/InayaChainRegistry.test.js

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("InayaChainRegistry", function () {
  let registry, owner, alice;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("InayaChainRegistry");
    registry = await Registry.deploy(owner.address);
    await registry.waitForDeployment();
  });

  it("registers a remote chain as active by default", async function () {
    await expect(registry.registerRemoteChain(11155111, 0, "Ethereum Sepolia"))
      .to.emit(registry, "RemoteChainRegistered")
      .withArgs(11155111, 0, "Ethereum Sepolia");

    expect(await registry.isChainActive(11155111)).to.equal(true);
    const [family, active, label] = await registry.getRemoteChain(11155111);
    expect(family).to.equal(0);
    expect(active).to.equal(true);
    expect(label).to.equal("Ethereum Sepolia");
  });

  it("rejects registering the same chain twice", async function () {
    await registry.registerRemoteChain(11155111, 0, "Ethereum Sepolia");
    await expect(registry.registerRemoteChain(11155111, 0, "Ethereum Sepolia")).to.be.revertedWith(
      "Chain already registered"
    );
  });

  it("can deactivate/reactivate a chain without losing its trusted-sender history", async function () {
    await registry.registerRemoteChain(80002, 0, "Polygon Amoy");
    const senderId = ethers.zeroPadValue(alice.address, 32);
    await registry.setTrustedRemoteContract(80002, senderId, true);

    await registry.setRemoteChainActive(80002, false);
    expect(await registry.isChainActive(80002)).to.equal(false);
    expect(await registry.isTrustedRemote(80002, senderId)).to.equal(false); // inactive chain -> never trusted

    await registry.setRemoteChainActive(80002, true);
    expect(await registry.isTrustedRemote(80002, senderId)).to.equal(true); // trust history preserved
  });

  it("supports more than one trusted sender per chain", async function () {
    await registry.registerRemoteChain(43113, 0, "Avalanche Fuji");
    const bridgeId = ethers.zeroPadValue(alice.address, 32);
    const gatewayId = ethers.zeroPadValue(owner.address, 32);

    await registry.setTrustedRemoteContract(43113, bridgeId, true);
    await registry.setTrustedRemoteContract(43113, gatewayId, true);

    expect(await registry.isTrustedRemote(43113, bridgeId)).to.equal(true);
    expect(await registry.isTrustedRemote(43113, gatewayId)).to.equal(true);

    await registry.setTrustedRemoteContract(43113, bridgeId, false);
    expect(await registry.isTrustedRemote(43113, bridgeId)).to.equal(false);
    expect(await registry.isTrustedRemote(43113, gatewayId)).to.equal(true);
  });

  it("rejects trusting a sender on an unregistered chain", async function () {
    const senderId = ethers.zeroPadValue(alice.address, 32);
    await expect(registry.setTrustedRemoteContract(999, senderId, true)).to.be.revertedWith(
      "Chain not registered"
    );
  });

  it("is false for an untrusted sender on a real registered+active chain", async function () {
    await registry.registerRemoteChain(97, 0, "BSC Testnet");
    const senderId = ethers.zeroPadValue(alice.address, 32);
    expect(await registry.isTrustedRemote(97, senderId)).to.equal(false);
  });

  it("returns all registered chain ids", async function () {
    await registry.registerRemoteChain(97, 0, "BSC Testnet");
    await registry.registerRemoteChain(11155111, 0, "Ethereum Sepolia");
    const ids = await registry.getRegisteredChainIds();
    expect(ids.map((id) => Number(id))).to.deep.equal([97, 11155111]);
  });

  describe("Access control", function () {
    it("rejects registerRemoteChain from a non-owner", async function () {
      await expect(
        registry.connect(alice).registerRemoteChain(97, 0, "BSC Testnet")
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("rejects setRemoteChainActive from a non-owner", async function () {
      await registry.registerRemoteChain(97, 0, "BSC Testnet");
      await expect(
        registry.connect(alice).setRemoteChainActive(97, false)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("rejects setTrustedRemoteContract from a non-owner", async function () {
      await registry.registerRemoteChain(97, 0, "BSC Testnet");
      const senderId = ethers.zeroPadValue(alice.address, 32);
      await expect(
        registry.connect(alice).setTrustedRemoteContract(97, senderId, true)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
