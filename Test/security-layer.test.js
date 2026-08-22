import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hre;

// STATUS constants, mirrored from InayaThreatReporter.sol's public constants.
const STATUS_UNVERIFIED = 0;
const STATUS_CONFIRMED = 1;
const STATUS_DISPUTED = 2;
const STATUS_CLEARED = 3;

const CATEGORY_PHISHING = 1;

function fakeThreatId(label) {
  // Mirrors how the backend computes threatId in production: keccak256 of the normalized
  // indicator string. Using an obviously-fake label here, never a real domain/IP (SOW §21).
  return ethers.keccak256(ethers.toUtf8Bytes(`test-threat:${label}`));
}

async function deploySecurityLayerFixture() {
  const [deployer, relayer, nodeA, nodeB, nodeC, nodeD, stranger] = await ethers.getSigners();

  const Registry = await ethers.getContractFactory("InayaThreatRegistry");
  const registry = await Registry.deploy(deployer.address); // placeholder reporter, corrected below
  await registry.waitForDeployment();

  const Reporter = await ethers.getContractFactory("InayaThreatReporter");
  const reporter = await Reporter.deploy(await registry.getAddress(), relayer.address);
  await reporter.waitForDeployment();

  await (await registry.setReporter(await reporter.getAddress())).wait();

  const NodeReputation = await ethers.getContractFactory("InayaNodeReputation");
  const nodeReputation = await NodeReputation.deploy(relayer.address);
  await nodeReputation.waitForDeployment();

  const SecurityPolicy = await ethers.getContractFactory("InayaSecurityPolicy");
  const securityPolicy = await SecurityPolicy.deploy(relayer.address);
  await securityPolicy.waitForDeployment();

  return { registry, reporter, nodeReputation, securityPolicy, deployer, relayer, nodeA, nodeB, nodeC, nodeD, stranger };
}

describe("Security Layer", function () {
  describe("InayaThreatRegistry access control", function () {
    it("rejects registerThreat from anyone but the reporter contract's relayer path", async function () {
      const { registry, stranger } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        registry.connect(stranger).registerThreat(fakeThreatId("direct-write"), CATEGORY_PHISHING)
      ).to.be.revertedWith("Caller is not the authorized reporter");
    });

    it("rejects updateThreatStatus from anyone but the reporter", async function () {
      const { registry, stranger } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        registry.connect(stranger).updateThreatStatus(fakeThreatId("direct-write"), STATUS_CONFIRMED, 9000, ethers.ZeroHash)
      ).to.be.revertedWith("Caller is not the authorized reporter");
    });

    it("only the owner can repoint the reporter address", async function () {
      const { registry, stranger, relayer } = await loadFixture(deploySecurityLayerFixture);
      await expect(registry.connect(stranger).setReporter(relayer.address)).to.be.reverted;
    });
  });

  describe("InayaThreatReporter access control", function () {
    it("rejects confirmThreat from anyone but the relayer", async function () {
      const { reporter, stranger } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        reporter.connect(stranger).confirmThreat(fakeThreatId("unauthorized"), CATEGORY_PHISHING, 9000, ethers.ZeroHash)
      ).to.be.revertedWith("Caller is not the authorized relayer");
    });

    it("rejects setThreatStatus from anyone but the relayer", async function () {
      const { reporter, stranger } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        reporter.connect(stranger).setThreatStatus(fakeThreatId("unauthorized"), STATUS_CLEARED, 0, ethers.ZeroHash)
      ).to.be.revertedWith("Caller is not the authorized relayer");
    });

    it("rejects confidenceBps above 10000", async function () {
      const { reporter, relayer } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        reporter.connect(relayer).confirmThreat(fakeThreatId("bad-confidence"), CATEGORY_PHISHING, 10001, ethers.ZeroHash)
      ).to.be.revertedWith("confidenceBps must be <= 10000");
    });
  });

  describe("Threat registration + confirmation round-trip", function () {
    it("registers and confirms a new threat end-to-end", async function () {
      const { registry, reporter, relayer } = await loadFixture(deploySecurityLayerFixture);
      const threatId = fakeThreatId("first-confirm");

      expect(await registry.isRegistered(threatId)).to.equal(false);

      await expect(reporter.connect(relayer).confirmThreat(threatId, CATEGORY_PHISHING, 9200, ethers.ZeroHash))
        .to.emit(reporter, "ThreatConfirmed")
        .withArgs(threatId, CATEGORY_PHISHING, 9200, ethers.ZeroHash);

      const threat = await registry.getThreat(threatId);
      expect(threat.category).to.equal(CATEGORY_PHISHING);
      expect(threat.status).to.equal(STATUS_CONFIRMED);
      expect(threat.confidenceBps).to.equal(9200);
      expect(threat.firstSeen).to.be.greaterThan(0n);
    });

    it("confirming an already-registered threat updates status without re-registering", async function () {
      const { registry, reporter, relayer } = await loadFixture(deploySecurityLayerFixture);
      const threatId = fakeThreatId("re-confirm");

      await (await reporter.connect(relayer).confirmThreat(threatId, CATEGORY_PHISHING, 8000, ethers.ZeroHash)).wait();
      const firstSeenAfterFirstConfirm = (await registry.getThreat(threatId)).firstSeen;

      await (await reporter.connect(relayer).confirmThreat(threatId, CATEGORY_PHISHING, 9500, ethers.ZeroHash)).wait();
      const threat = await registry.getThreat(threatId);

      expect(threat.confidenceBps).to.equal(9500);
      expect(threat.firstSeen).to.equal(firstSeenAfterFirstConfirm);
    });

    it("setThreatStatus can later clear a confirmed threat (false-positive override)", async function () {
      const { registry, reporter, relayer } = await loadFixture(deploySecurityLayerFixture);
      const threatId = fakeThreatId("false-positive");

      await (await reporter.connect(relayer).confirmThreat(threatId, CATEGORY_PHISHING, 9000, ethers.ZeroHash)).wait();
      await expect(reporter.connect(relayer).setThreatStatus(threatId, STATUS_CLEARED, 0, ethers.ZeroHash))
        .to.emit(reporter, "ThreatStatusChanged")
        .withArgs(threatId, STATUS_CLEARED, 0, ethers.ZeroHash);

      const threat = await registry.getThreat(threatId);
      expect(threat.status).to.equal(STATUS_CLEARED);
    });

    it("setThreatStatus reverts for a threat that was never registered", async function () {
      const { reporter, relayer } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        reporter.connect(relayer).setThreatStatus(fakeThreatId("never-seen"), STATUS_DISPUTED, 0, ethers.ZeroHash)
      ).to.be.revertedWith("Unknown threat");
    });
  });

  describe("4-node simulated confirmation (SOW §24 demo flow)", function () {
    it("confirms a threat with a contributingNodesHash covering all 4 simulated reporting nodes", async function () {
      const { registry, reporter, relayer, nodeA, nodeB, nodeC, nodeD } = await loadFixture(deploySecurityLayerFixture);
      const threatId = fakeThreatId("multi-node-malicious-example.invalid");

      // Mirrors what the backend's computeThreatConfidence does off-chain: once independent
      // observations from these 4 nodes push confidence past the threshold, it hashes the
      // sorted contributing-node address list and passes that hash on-chain as the auditable
      // anchor (the full list itself stays off-chain in MongoDB for scale).
      const nodes = [nodeA.address, nodeB.address, nodeC.address, nodeD.address].sort();
      const contributingNodesHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [nodes])
      );

      await reporter.connect(relayer).confirmThreat(threatId, CATEGORY_PHISHING, 9800, contributingNodesHash);

      const threat = await registry.getThreat(threatId);
      expect(threat.status).to.equal(STATUS_CONFIRMED);
      expect(threat.confidenceBps).to.equal(9800);
      expect(threat.contributingNodesHash).to.equal(contributingNodesHash);
    });
  });

  describe("InayaNodeReputation", function () {
    it("returns the neutral default score for a node that's never been checkpointed", async function () {
      const { nodeReputation, nodeA } = await loadFixture(deploySecurityLayerFixture);
      const rep = await nodeReputation.getReputation(nodeA.address);
      expect(rep.scoreBps).to.equal(5000n);
      expect(rep.lastCheckpoint).to.equal(0n);
    });

    it("rejects checkpointReputation from anyone but the relayer", async function () {
      const { nodeReputation, stranger, nodeA } = await loadFixture(deploySecurityLayerFixture);
      await expect(
        nodeReputation.connect(stranger).checkpointReputation(nodeA.address, 8000, 1, 0)
      ).to.be.revertedWith("Caller is not the authorized relayer");
    });

    it("accumulates confirmed/false-positive counts across checkpoints", async function () {
      const { nodeReputation, relayer, nodeA } = await loadFixture(deploySecurityLayerFixture);
      await (await nodeReputation.connect(relayer).checkpointReputation(nodeA.address, 6000, 3, 0)).wait();
      await (await nodeReputation.connect(relayer).checkpointReputation(nodeA.address, 6500, 2, 1)).wait();

      const rep = await nodeReputation.getReputation(nodeA.address);
      expect(rep.scoreBps).to.equal(6500n);
      expect(rep.totalConfirmed).to.equal(5n);
      expect(rep.totalFalsePositive).to.equal(1n);
    });
  });

  describe("InayaSecurityPolicy", function () {
    it("publishes version 1 and exposes it as current", async function () {
      const { securityPolicy, relayer } = await loadFixture(deploySecurityLayerFixture);
      const policyHash = ethers.keccak256(ethers.toUtf8Bytes('{"policy":"v1"}'));

      await expect(securityPolicy.connect(relayer).publishPolicy(1, policyHash, "https://example.test/policy/v1"))
        .to.emit(securityPolicy, "PolicyPublished")
        .withArgs(1, policyHash, "https://example.test/policy/v1", anyValue());

      expect(await securityPolicy.currentVersion()).to.equal(1n);
      const current = await securityPolicy.getCurrentPolicy();
      expect(current.policyHash).to.equal(policyHash);
    });

    it("rejects a version that skips ahead", async function () {
      const { securityPolicy, relayer } = await loadFixture(deploySecurityLayerFixture);
      const policyHash = ethers.keccak256(ethers.toUtf8Bytes('{"policy":"v2-skip"}'));
      await expect(
        securityPolicy.connect(relayer).publishPolicy(2, policyHash, "https://example.test/policy/v2")
      ).to.be.revertedWith("Version must increment by exactly 1");
    });

    it("rejects publishPolicy from anyone but the relayer", async function () {
      const { securityPolicy, stranger } = await loadFixture(deploySecurityLayerFixture);
      const policyHash = ethers.keccak256(ethers.toUtf8Bytes('{"policy":"unauthorized"}'));
      await expect(
        securityPolicy.connect(stranger).publishPolicy(1, policyHash, "https://example.test/policy/v1")
      ).to.be.revertedWith("Caller is not the authorized relayer");
    });
  });
});

// hardhat-chai-matchers doesn't export a bare "any value" matcher for withArgs positions the way
// some other frameworks do -- this tiny local helper stands in for the timestamp argument, which
// varies by block and isn't worth asserting exactly.
function anyValue() {
  return (_actual) => true;
}
