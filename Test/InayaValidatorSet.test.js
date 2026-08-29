// Test/InayaValidatorSet.test.js
//
// Run with: npx hardhat test Test/InayaValidatorSet.test.js

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

// verifyThreshold's `digest` argument is the ALREADY EIP-191-prefixed hash (mirrors
// InayaMessenger.executeMessage, which passes MessageHashUtils.toEthSignedMessageHash(messageId)).
// A validator signs the raw messageId via signMessage, which prefixes+hashes it internally --
// ethers.hashMessage() computes that same prefixed digest independently so the test can pass it
// straight into verifyThreshold.
function toDigest(rawHash) {
  return ethers.hashMessage(ethers.getBytes(rawHash));
}

async function signRaw(signer, rawHashHex) {
  return signer.signMessage(ethers.getBytes(rawHashHex));
}

describe("InayaValidatorSet", function () {
  let validatorSet, owner, v1, v2, v3, outsider;
  const rawHash = ethers.keccak256(ethers.toUtf8Bytes("some message"));
  const digest = toDigest(rawHash);

  beforeEach(async function () {
    [owner, v1, v2, v3, outsider] = await ethers.getSigners();
    const ValidatorSet = await ethers.getContractFactory("InayaValidatorSet");
    validatorSet = await ValidatorSet.deploy(owner.address, [v1.address, v2.address, v3.address], 2);
    await validatorSet.waitForDeployment();
  });

  it("initializes with the given validators and threshold", async function () {
    expect(await validatorSet.getThreshold()).to.equal(2);
    const validators = await validatorSet.getValidators();
    expect(Array.from(validators)).to.have.members([v1.address, v2.address, v3.address]);
  });

  it("rejects an initial threshold of 0 or above the validator count", async function () {
    const ValidatorSet = await ethers.getContractFactory("InayaValidatorSet");
    await expect(ValidatorSet.deploy(owner.address, [v1.address], 0)).to.be.revertedWith("Invalid threshold");
    await expect(ValidatorSet.deploy(owner.address, [v1.address], 2)).to.be.revertedWith("Invalid threshold");
  });

  it("verifies a threshold-signed digest", async function () {
    const sig1 = await signRaw(v1, rawHash);
    const sig2 = await signRaw(v2, rawHash);
    const [ok, count] = await validatorSet.verifyThreshold(digest, [sig1, sig2]);
    expect(ok).to.equal(true);
    expect(count).to.equal(2);
  });

  it("rejects below-threshold signatures", async function () {
    const sig1 = await signRaw(v1, rawHash);
    const [ok, count] = await validatorSet.verifyThreshold(digest, [sig1]);
    expect(ok).to.equal(false);
    expect(count).to.equal(1);
  });

  it("does not double-count a duplicate signature from the same validator", async function () {
    const sig1 = await signRaw(v1, rawHash);
    const [ok, count] = await validatorSet.verifyThreshold(digest, [sig1, sig1]);
    expect(ok).to.equal(false);
    expect(count).to.equal(1);
  });

  it("ignores a signature from a non-validator without blocking the rest", async function () {
    const sig1 = await signRaw(v1, rawHash);
    const sigOutsider = await signRaw(outsider, rawHash);
    const [ok, count] = await validatorSet.verifyThreshold(digest, [sigOutsider, sig1, sig1]);
    expect(count).to.equal(1);
    expect(ok).to.equal(false);
  });

  it("never reverts on a malformed signature -- it just doesn't count", async function () {
    const malformed = "0x1234";
    const sig1 = await signRaw(v1, rawHash);
    const sig2 = await signRaw(v2, rawHash);
    const [ok, count] = await validatorSet.verifyThreshold(digest, [malformed, sig1, sig2]);
    expect(ok).to.equal(true);
    expect(count).to.equal(2);
  });

  it("rejects a signature over a different message from being counted against this digest", async function () {
    const otherHash = ethers.keccak256(ethers.toUtf8Bytes("a different message"));
    const sigOverOther = await signRaw(v1, otherHash); // signs a DIFFERENT message than `digest` corresponds to
    const sig2 = await signRaw(v2, rawHash);
    const [ok, count] = await validatorSet.verifyThreshold(digest, [sigOverOther, sig2]);
    expect(count).to.equal(1); // only v2's signature recovers correctly against `digest`
    expect(ok).to.equal(false);
  });

  describe("Validator management", function () {
    it("adds and removes a validator", async function () {
      await expect(validatorSet.addValidator(outsider.address))
        .to.emit(validatorSet, "ValidatorAdded")
        .withArgs(outsider.address);
      expect(await validatorSet.isValidator(outsider.address)).to.equal(true);

      await expect(validatorSet.removeValidator(outsider.address))
        .to.emit(validatorSet, "ValidatorRemoved")
        .withArgs(outsider.address);
      expect(await validatorSet.isValidator(outsider.address)).to.equal(false);
    });

    it("rejects removing a validator that would drop the count below threshold", async function () {
      await validatorSet.removeValidator(v3.address); // 3 -> 2, still == threshold, allowed
      await expect(validatorSet.removeValidator(v2.address)).to.be.revertedWith("Would drop below threshold");
    });

    it("rejects adding a duplicate validator", async function () {
      await expect(validatorSet.addValidator(v1.address)).to.be.revertedWith("Already a validator");
    });

    it("updates the threshold within bounds", async function () {
      await expect(validatorSet.setThreshold(3)).to.emit(validatorSet, "ThresholdUpdated").withArgs(3);
      expect(await validatorSet.getThreshold()).to.equal(3);
    });

    it("rejects a threshold of 0 or above the validator count", async function () {
      await expect(validatorSet.setThreshold(0)).to.be.revertedWith("Invalid threshold");
      await expect(validatorSet.setThreshold(4)).to.be.revertedWith("Invalid threshold");
    });

    it("rejects management calls from a non-owner", async function () {
      await expect(
        validatorSet.connect(outsider).addValidator(outsider.address)
      ).to.be.revertedWithCustomError(validatorSet, "OwnableUnauthorizedAccount");
      await expect(
        validatorSet.connect(outsider).setThreshold(1)
      ).to.be.revertedWithCustomError(validatorSet, "OwnableUnauthorizedAccount");
    });
  });
});
