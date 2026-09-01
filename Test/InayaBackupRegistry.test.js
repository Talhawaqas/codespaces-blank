// Test/InayaBackupRegistry.test.js
//
// Run with: npx hardhat test Test/InayaBackupRegistry.test.js

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const HealthState = { Protected: 0, Rebuilding: 1, Degraded: 2, RecoveryRequired: 3, RecoveryFailed: 4 };

describe("InayaBackupRegistry", function () {
  let registry, custody, owner, alice, bob;
  let fileHash;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const MockCustody = await ethers.getContractFactory("MockInayaCustody");
    custody = await MockCustody.deploy();
    await custody.waitForDeployment();

    const Registry = await ethers.getContractFactory("InayaBackupRegistry");
    registry = await Registry.deploy(await custody.getAddress());
    await registry.waitForDeployment();

    fileHash = ethers.id("test-file-1");
    await custody.setAsset(fileHash, alice.address, "cidAlpha123", "cidBeta456", Math.floor(Date.now() / 1000));
  });

  it("rejects deployment with a zero custody address", async function () {
    const Registry = await ethers.getContractFactory("InayaBackupRegistry");
    await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWith("Custody address required");
  });

  describe("registerRedundancyCommitment", function () {
    it("registers a commitment, reading the real owner from InayaCustody rather than trusting an argument", async function () {
      const replicaSetHash = ethers.id("pinata+filebase-v1");
      await expect(registry.registerRedundancyCommitment(fileHash, 2, replicaSetHash))
        .to.emit(registry, "RedundancyCommitmentRegistered")
        .withArgs(fileHash, alice.address, 2, replicaSetHash);

      const record = await registry.getBackupRecord(fileHash);
      expect(record.owner).to.equal(alice.address);
      expect(record.targetReplicaCount).to.equal(2);
      expect(record.replicaSetHash).to.equal(replicaSetHash);
      expect(record.healthState).to.equal(HealthState.Protected);
      expect(record.registeredAt).to.be.gt(0n);
    });

    it("rejects registering for a fileHash InayaCustody has never seen", async function () {
      const unknownHash = ethers.id("never-uploaded");
      await expect(
        registry.registerRedundancyCommitment(unknownHash, 2, ethers.id("x"))
      ).to.be.revertedWith("Asset not found in InayaCustody");
    });

    it("rejects a zero target replica count", async function () {
      await expect(registry.registerRedundancyCommitment(fileHash, 0, ethers.id("x"))).to.be.revertedWith(
        "targetReplicaCount must be > 0"
      );
    });

    it("rejects registering the same fileHash twice", async function () {
      await registry.registerRedundancyCommitment(fileHash, 2, ethers.id("v1"));
      await expect(registry.registerRedundancyCommitment(fileHash, 2, ethers.id("v2"))).to.be.revertedWith(
        "Already registered"
      );
    });
  });

  describe("updateRedundancyCommitment", function () {
    beforeEach(async function () {
      await registry.registerRedundancyCommitment(fileHash, 2, ethers.id("v1"));
    });

    it("updates the target replica count and topology hash without touching healthState", async function () {
      const newHash = ethers.id("pinata+filebase+backup3-v2");
      await expect(registry.updateRedundancyCommitment(fileHash, 3, newHash))
        .to.emit(registry, "RedundancyCommitmentUpdated")
        .withArgs(fileHash, 3, newHash);

      const record = await registry.getBackupRecord(fileHash);
      expect(record.targetReplicaCount).to.equal(3);
      expect(record.replicaSetHash).to.equal(newHash);
      expect(record.healthState).to.equal(HealthState.Protected);
    });

    it("rejects updating an unknown asset", async function () {
      const unknownHash = ethers.id("never-registered");
      await expect(registry.updateRedundancyCommitment(unknownHash, 2, ethers.id("x"))).to.be.revertedWith(
        "Unknown asset"
      );
    });
  });

  describe("setBackupHealthState", function () {
    beforeEach(async function () {
      await registry.registerRedundancyCommitment(fileHash, 2, ethers.id("v1"));
    });

    it("records a real state transition and updates lastStateChangeAt", async function () {
      const before = await registry.getBackupRecord(fileHash);
      await expect(registry.setBackupHealthState(fileHash, HealthState.Degraded))
        .to.emit(registry, "BackupHealthChanged")
        .withArgs(fileHash, HealthState.Protected, HealthState.Degraded);

      const after = await registry.getBackupRecord(fileHash);
      expect(after.healthState).to.equal(HealthState.Degraded);
      expect(after.lastStateChangeAt).to.be.gte(before.lastStateChangeAt);
    });

    it("walks through the full recovery lifecycle: Protected -> Degraded -> RecoveryRequired -> Rebuilding -> Protected", async function () {
      await registry.setBackupHealthState(fileHash, HealthState.Degraded);
      await registry.setBackupHealthState(fileHash, HealthState.RecoveryRequired);
      await registry.setBackupHealthState(fileHash, HealthState.Rebuilding);
      await registry.setBackupHealthState(fileHash, HealthState.Protected);
      const record = await registry.getBackupRecord(fileHash);
      expect(record.healthState).to.equal(HealthState.Protected);
    });

    it("is a silent no-op (no event, no storage write) when the new state equals the current one", async function () {
      const before = await registry.getBackupRecord(fileHash);
      const tx = await registry.setBackupHealthState(fileHash, HealthState.Protected);
      const receipt = await tx.wait();
      expect(receipt.logs.length).to.equal(0);
      const after = await registry.getBackupRecord(fileHash);
      expect(after.lastStateChangeAt).to.equal(before.lastStateChangeAt);
    });

    it("rejects setting health state for an unknown asset", async function () {
      const unknownHash = ethers.id("never-registered");
      await expect(registry.setBackupHealthState(unknownHash, HealthState.Degraded)).to.be.revertedWith(
        "Unknown asset"
      );
    });
  });

  describe("Access control", function () {
    it("rejects registerRedundancyCommitment from a non-owner", async function () {
      await expect(
        registry.connect(bob).registerRedundancyCommitment(fileHash, 2, ethers.id("v1"))
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("rejects updateRedundancyCommitment from a non-owner", async function () {
      await registry.registerRedundancyCommitment(fileHash, 2, ethers.id("v1"));
      await expect(
        registry.connect(bob).updateRedundancyCommitment(fileHash, 3, ethers.id("v2"))
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("rejects setBackupHealthState from a non-owner", async function () {
      await registry.registerRedundancyCommitment(fileHash, 2, ethers.id("v1"));
      await expect(
        registry.connect(bob).setBackupHealthState(fileHash, HealthState.Degraded)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("rejects registration from the asset owner themselves (owner is the file's uploader, not the backend operator)", async function () {
      await expect(
        registry.connect(alice).registerRedundancyCommitment(fileHash, 2, ethers.id("v1"))
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
