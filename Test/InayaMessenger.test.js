// Test/InayaMessenger.test.js
//
// Run with: npx hardhat test Test/InayaMessenger.test.js

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const MSG_TOKEN_MINT = 0;

async function signRaw(signer, rawHashHex) {
  return signer.signMessage(ethers.getBytes(rawHashHex));
}

describe("InayaMessenger", function () {
  let messenger, registry, validatorSet, handler;
  let owner, v1, v2, sender, outsider, thisChainId;

  beforeEach(async function () {
    [owner, v1, v2, sender, outsider] = await ethers.getSigners();
    thisChainId = (await ethers.provider.getNetwork()).chainId;

    const Registry = await ethers.getContractFactory("InayaChainRegistry");
    registry = await Registry.deploy(owner.address);
    await registry.waitForDeployment();

    const ValidatorSet = await ethers.getContractFactory("InayaValidatorSet");
    validatorSet = await ValidatorSet.deploy(owner.address, [v1.address, v2.address], 2);
    await validatorSet.waitForDeployment();

    const Messenger = await ethers.getContractFactory("InayaMessenger");
    messenger = await Messenger.deploy(owner.address, await registry.getAddress(), await validatorSet.getAddress());
    await messenger.waitForDeployment();

    const Handler = await ethers.getContractFactory("MockMessageHandler");
    handler = await Handler.deploy();
    await handler.waitForDeployment();

    // Register "this chain" as both a valid destination (for sendMessage) and, since the test
    // drives both legs of a message on a single Hardhat node, a trusted remote sender chain
    // (for executeMessage) -- see Test/CrossChainIntegration.test.js for a topology that keeps
    // the two roles on genuinely separate contract sets.
    await registry.registerRemoteChain(thisChainId, 0, "self (test)");
    await registry.setTrustedRemoteContract(thisChainId, ethers.zeroPadValue(sender.address, 32), true);

    await messenger.setAuthorizedSender(sender.address, true);
    await messenger.setHandler(MSG_TOKEN_MINT, await handler.getAddress());
  });

  function toPlainMessage(m) {
    // ethers v6 returns struct events as frozen Result tuples -- re-passing one straight back
    // in as a call argument trips its internal encoder, so unwrap to a plain object first.
    return {
      sourceChainId: m.sourceChainId,
      sourceContract: m.sourceContract,
      destChainId: m.destChainId,
      destContract: m.destContract,
      nonce: m.nonce,
      msgType: m.msgType,
      payload: m.payload,
    };
  }

  async function sendAndCapture(payload = "0x") {
    const destContract = ethers.zeroPadValue(await handler.getAddress(), 32);
    const tx = await messenger.connect(sender).sendMessage(thisChainId, destContract, MSG_TOKEN_MINT, payload);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((l) => { try { return messenger.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MessageSent");
    return { messageId: event.args.messageId, message: toPlainMessage(event.args.message) };
  }

  async function signThreshold(messageId) {
    const sig1 = await signRaw(v1, messageId);
    const sig2 = await signRaw(v2, messageId);
    return [sig1, sig2];
  }

  describe("sendMessage", function () {
    it("rejects a non-authorized sender", async function () {
      const destContract = ethers.zeroPadValue(await handler.getAddress(), 32);
      await expect(
        messenger.connect(outsider).sendMessage(thisChainId, destContract, MSG_TOKEN_MINT, "0x")
      ).to.be.revertedWith("Caller is not an authorized sender");
    });

    it("rejects an inactive/unregistered destination chain", async function () {
      const destContract = ethers.zeroPadValue(await handler.getAddress(), 32);
      await expect(
        messenger.connect(sender).sendMessage(999, destContract, MSG_TOKEN_MINT, "0x")
      ).to.be.revertedWith("Destination chain not active");
    });

    it("assigns monotonically increasing per-sender nonces", async function () {
      const { message: m1 } = await sendAndCapture();
      const { message: m2 } = await sendAndCapture();
      expect(m1.nonce).to.equal(1);
      expect(m2.nonce).to.equal(2);
    });
  });

  describe("executeMessage", function () {
    it("dispatches a valid threshold-signed message and marks it Completed", async function () {
      const { messageId, message } = await sendAndCapture();
      const signatures = await signThreshold(messageId);

      await expect(messenger.executeMessage(message, signatures)).to.emit(messenger, "MessageExecuted").withArgs(messageId);
      expect(await messenger.getMessageStatus(messageId)).to.equal(2); // Completed
      expect(await handler.callCount()).to.equal(1);
    });

    it("rejects wrong destination chain (checked first, before any hash/signature work)", async function () {
      const { message } = await sendAndCapture();
      const badMessage = { ...message, destChainId: 999n };
      await expect(messenger.executeMessage(badMessage, [])).to.be.revertedWith("Wrong destination chain");
    });

    it("rejects an untrusted sender (checked before signatures, so no valid signature is even needed)", async function () {
      // Same message shape a real sendMessage would produce, but claiming to come from
      // `outsider` instead of the one registered-trusted `sender`.
      const destContract = ethers.zeroPadValue(await handler.getAddress(), 32);
      const forgedMessage = {
        sourceChainId: thisChainId,
        sourceContract: ethers.zeroPadValue(outsider.address, 32),
        destChainId: thisChainId,
        destContract,
        nonce: 1,
        msgType: MSG_TOKEN_MINT,
        payload: "0x",
      };
      await expect(messenger.executeMessage(forgedMessage, [])).to.be.revertedWith("Untrusted sender");
    });

    it("rejects insufficient signatures", async function () {
      const { messageId, message } = await sendAndCapture();
      const sig1 = await signRaw(v1, messageId);
      await expect(messenger.executeMessage(message, [sig1])).to.be.revertedWith("Insufficient validator signatures");
    });

    it("rejects replay of an already-Completed message", async function () {
      const { messageId, message } = await sendAndCapture();
      const signatures = await signThreshold(messageId);
      await messenger.executeMessage(message, signatures);
      await expect(messenger.executeMessage(message, signatures)).to.be.revertedWith("Already executed");
    });

    it("marks a reverting handler's message Failed, and it stays retryable", async function () {
      await handler.setMode(2); // RevertWithReason
      const { messageId, message } = await sendAndCapture();
      const signatures = await signThreshold(messageId);

      await expect(messenger.executeMessage(message, signatures))
        .to.emit(messenger, "MessageFailed")
        .withArgs(messageId, "mock handler reverted");
      expect(await messenger.getMessageStatus(messageId)).to.equal(3); // Failed

      // Retry with the identical (message, signatures) once the handler is fixed.
      await handler.setMode(0); // Succeed
      await expect(messenger.executeMessage(message, signatures)).to.emit(messenger, "MessageExecuted").withArgs(messageId);
      expect(await messenger.getMessageStatus(messageId)).to.equal(2); // Completed
    });

    it("marks a handler returning false as Failed (no revert needed)", async function () {
      await handler.setMode(1); // ReturnFalse
      const { messageId, message } = await sendAndCapture();
      const signatures = await signThreshold(messageId);

      await messenger.executeMessage(message, signatures);
      expect(await messenger.getMessageStatus(messageId)).to.equal(3); // Failed
    });

    it("rejects when no handler is registered for the msgType", async function () {
      await messenger.setHandler(MSG_TOKEN_MINT, ethers.ZeroAddress);
      const { messageId, message } = await sendAndCapture();
      const signatures = await signThreshold(messageId);
      await expect(messenger.executeMessage(message, signatures)).to.be.revertedWith("No handler registered for msgType");
    });

    it("blocks send and execute while paused, restores after unpause", async function () {
      await messenger.pauseCrossChain();
      const destContract = ethers.zeroPadValue(await handler.getAddress(), 32);
      await expect(
        messenger.connect(sender).sendMessage(thisChainId, destContract, MSG_TOKEN_MINT, "0x")
      ).to.be.revertedWithCustomError(messenger, "EnforcedPause");

      await messenger.unpauseCrossChain();
      const { messageId, message } = await sendAndCapture();
      const signatures = await signThreshold(messageId);
      await messenger.executeMessage(message, signatures);
      expect(await messenger.getMessageStatus(messageId)).to.equal(2); // Completed
    });
  });
});
