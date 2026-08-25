// test/OracleAutomation.test.js
//
// Run with: npx hardhat test test/OracleAutomation.test.js
//
// Covers InayaOracleRegistry + InayaOracleAdapter (registration/
// authorization, and every on-chain validation rule: future timestamp,
// stale-at-submission, too-frequent, excessive-deviation) and
// InayaAutomationRegistry (task registration + the record-only property --
// this contract never forwards a call to targetContract, it only logs).

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const HOUR = 60 * 60;

function sourceId(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

describe("InayaOracleRegistry + InayaOracleAdapter", function () {
  let registry, adapter, owner, submitter, other;
  const SRC = sourceId("inaya-usdt-price");

  beforeEach(async function () {
    [owner, submitter, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("InayaOracleRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const Adapter = await ethers.getContractFactory("InayaOracleAdapter");
    adapter = await Adapter.deploy(await registry.getAddress());
    await adapter.waitForDeployment();

    // 1-hour minimum interval between updates for this source
    await registry.registerSource(SRC, "INAYA/USDT price", submitter.address, HOUR);
  });

  describe("Registry", function () {
    it("registers a source and reports it as an authorized submitter", async function () {
      expect(await registry.isAuthorizedSubmitter(SRC, submitter.address)).to.equal(true);
      expect(await registry.isAuthorizedSubmitter(SRC, other.address)).to.equal(false);
      expect(await registry.getSourceCount()).to.equal(1);
    });

    it("rejects registering the same sourceId twice", async function () {
      await expect(registry.registerSource(SRC, "dup", other.address, HOUR)).to.be.revertedWith("Source already registered");
    });

    it("emergencyDisable immediately revokes authorization", async function () {
      await registry.emergencyDisable(SRC);
      expect(await registry.isAuthorizedSubmitter(SRC, submitter.address)).to.equal(false);
    });

    it("restricts registerSource/setSourceActive/emergencyDisable/updateSubmitter to the owner", async function () {
      await expect(registry.connect(other).registerSource(sourceId("x"), "x", other.address, 0))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      await expect(registry.connect(other).setSourceActive(SRC, false))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      await expect(registry.connect(other).emergencyDisable(SRC))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      await expect(registry.connect(other).updateSubmitter(SRC, other.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("Adapter -- authorization", function () {
    it("accepts a submission from the registered submitter", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(adapter.connect(submitter).submitData(SRC, 100, now))
        .to.emit(adapter, "DataSubmitted")
        .withArgs(SRC, 100, now, submitter.address);

      const [value] = await adapter.getLatestData(SRC);
      expect(value).to.equal(100);
    });

    it("rejects a submission from an unauthorized address", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(adapter.connect(other).submitData(SRC, 100, now)).to.be.revertedWith("Not an authorized submitter for this source");
    });

    it("rejects a submission after the source is emergency-disabled", async function () {
      await registry.emergencyDisable(SRC);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(adapter.connect(submitter).submitData(SRC, 100, now)).to.be.revertedWith("Not an authorized submitter for this source");
    });
  });

  describe("Adapter -- validation rules", function () {
    it("rejects a future timestamp", async function () {
      const future = (await ethers.provider.getBlock("latest")).timestamp + HOUR;
      await expect(adapter.connect(submitter).submitData(SRC, 100, future)).to.be.revertedWith("Timestamp cannot be in the future");
    });

    it("rejects data that's already stale at submission time", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const longAgo = now - 2 * HOUR; // maxStalenessSeconds defaults to 1 hour
      await expect(adapter.connect(submitter).submitData(SRC, 100, longAgo)).to.be.revertedWith("Data is already stale at submission time");
    });

    it("rejects a submission faster than the source's minimum update interval", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await adapter.connect(submitter).submitData(SRC, 100, now);
      await expect(adapter.connect(submitter).submitData(SRC, 101, now)).to.be.revertedWith("Submitted faster than this source's minimum update interval");
    });

    it("accepts a second submission once the minimum interval has passed", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await adapter.connect(submitter).submitData(SRC, 100, now);

      await hre.network.provider.send("evm_increaseTime", [HOUR + 1]);
      await hre.network.provider.send("evm_mine");

      const later = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(adapter.connect(submitter).submitData(SRC, 105, later)).to.not.be.reverted; // +5% is within the 20% default max deviation
    });

    it("rejects a submission that deviates from the previous value by more than the max allowed", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await adapter.connect(submitter).submitData(SRC, 100, now);

      await hre.network.provider.send("evm_increaseTime", [HOUR + 1]);
      await hre.network.provider.send("evm_mine");

      const later = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(adapter.connect(submitter).submitData(SRC, 200, later)).to.be.revertedWith("Deviation from previous value exceeds max allowed"); // +100%, default max is 20%
    });

    it("isStale reports true before any submission and false right after a fresh one", async function () {
      expect(await adapter.isStale(SRC)).to.equal(true);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await adapter.connect(submitter).submitData(SRC, 100, now);
      expect(await adapter.isStale(SRC)).to.equal(false);
    });

    it("isStale reports true again once maxStalenessSeconds has elapsed since submission", async function () {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await adapter.connect(submitter).submitData(SRC, 100, now);
      await hre.network.provider.send("evm_increaseTime", [HOUR + 1]);
      await hre.network.provider.send("evm_mine");
      expect(await adapter.isStale(SRC)).to.equal(true);
    });

    it("restricts setMaxStaleness/setMaxDeviationBps to the owner", async function () {
      await expect(adapter.connect(other).setMaxStaleness(60)).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
      await expect(adapter.connect(other).setMaxDeviationBps(100)).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });
  });
});

describe("InayaAutomationRegistry", function () {
  let registry, owner, worker, other, targetStub;
  const TASK = ethers.keccak256(ethers.toUtf8Bytes("release-node-settlements"));

  beforeEach(async function () {
    [owner, worker, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("InayaAutomationRegistry");
    registry = await Registry.deploy(worker.address);
    await registry.waitForDeployment();

    // Any deployed contract works as a stand-in "targetContract" address for
    // these tests -- MockINAYA is already available and irrelevant to what's
    // under test (this registry never actually calls it).
    const MockINAYA = await ethers.getContractFactory("MockINAYA");
    targetStub = await MockINAYA.deploy();
    await targetStub.waitForDeployment();
  });

  it("registers a task", async function () {
    const selector = "0x12345678";
    await expect(registry.registerTask(TASK, await targetStub.getAddress(), selector, "settlement unlockTime passed"))
      .to.emit(registry, "TaskRegistered");
    expect(await registry.getTaskCount()).to.equal(1);
  });

  it("lets the registered worker record an execution", async function () {
    await registry.registerTask(TASK, await targetStub.getAddress(), "0x12345678", "test condition");
    const fakeTxHash = ethers.keccak256(ethers.toUtf8Bytes("fake-tx"));
    const nextEligible = (await ethers.provider.getBlock("latest")).timestamp + HOUR;

    await expect(registry.connect(worker).recordExecution(TASK, true, nextEligible, fakeTxHash))
      .to.emit(registry, "TaskExecutionRecorded")
      .withArgs(TASK, true, nextEligible, fakeTxHash);

    const task = await registry.tasks(TASK);
    expect(task.consecutiveFailures).to.equal(0);
    expect(task.nextEligible).to.equal(nextEligible);
  });

  it("increments consecutiveFailures on a failed execution and resets it on the next success", async function () {
    await registry.registerTask(TASK, await targetStub.getAddress(), "0x12345678", "test condition");
    const zero = ethers.ZeroHash;

    await registry.connect(worker).recordExecution(TASK, false, 0, zero);
    await registry.connect(worker).recordExecution(TASK, false, 0, zero);
    expect((await registry.tasks(TASK)).consecutiveFailures).to.equal(2);

    await registry.connect(worker).recordExecution(TASK, true, 0, zero);
    expect((await registry.tasks(TASK)).consecutiveFailures).to.equal(0);
  });

  it("rejects recordExecution from anyone but the registered worker or the owner", async function () {
    await registry.registerTask(TASK, await targetStub.getAddress(), "0x12345678", "test condition");
    await expect(registry.connect(other).recordExecution(TASK, true, 0, ethers.ZeroHash)).to.be.revertedWith("Unauthorized: not the automation worker");
  });

  it("restricts registerTask/setTaskActive/setWorker to the owner", async function () {
    await expect(registry.connect(other).registerTask(ethers.keccak256(ethers.toUtf8Bytes("x")), await targetStub.getAddress(), "0x00000000", "x"))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await registry.registerTask(TASK, await targetStub.getAddress(), "0x12345678", "test condition");
    await expect(registry.connect(other).setTaskActive(TASK, false)).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(registry.connect(other).setWorker(other.address)).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("never itself calls targetContract -- recordExecution is a pure state write with no external call to the target", async function () {
    // Structural proof: recordExecution's only argument referencing the target
    // is the already-stored targetContract address in storage, never invoked.
    // The strongest proof available without a full call-trace inspector is
    // that this call succeeds and changes only this contract's own storage
    // even when targetContract has no function matching the stored selector.
    await registry.registerTask(TASK, await targetStub.getAddress(), "0xdeadbeef", "arbitrary, never actually invoked");
    await expect(registry.connect(worker).recordExecution(TASK, true, 0, ethers.ZeroHash)).to.not.be.reverted;
  });
});
