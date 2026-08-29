// Test/InayaTokenBridge.test.js
//
// Run with: npx hardhat test Test/InayaTokenBridge.test.js
//
// Uses the REAL fee-charging InayaToken (a test-only copy under contracts/, see its header
// comment) rather than the fee-free MockINAYA, specifically to exercise InayaTokenBridgeHome's
// fee-buffer accounting.
//
// SIMULATION LIMITATION: home and "spoke" both run on the same Hardhat Network instance, so
// they share one real block.chainid. Each side gets its own Messenger/ChainRegistry/
// ValidatorSet (mirroring the real per-chain deployment topology), and chain identity is
// represented with an arbitrary numeric *label* rather than each side's real target chainId --
// registries are wired so executeMessage's `destChainId == block.chainid` check is satisfied by
// using `thisChainId` as that label throughout. This validates the contracts' actual lock/mint/
// burn/fee-buffer/replay logic precisely, but is not a substitute for the real multi-testnet
// dry run in Phase 2 -- see Test/CrossChainIntegration.test.js for the same caveat.

import { expect } from "chai";
import hre from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs.js";
const { ethers } = hre;

const MSG_TOKEN_MINT = 0;
const MSG_TOKEN_BURN_NOTICE = 1;
const BURN_ACTION_PLAIN = 0;
const BURN_ACTION_ROUTE = 1;
const FAMILY_EVM = 0;

const ONE_INAYA = ethers.parseUnits("1", 18);
const TRANSFER_FEE = 100000000000000n; // 0.0001 INAYA, matches InayaToken.transferFee

async function signRaw(signer, rawHashHex) {
  return signer.signMessage(ethers.getBytes(rawHashHex));
}

function toPlainMessage(m) {
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

describe("InayaTokenBridgeHome + InayaTokenBridgeSpoke", function () {
  let inaya, wrapped;
  let registryHome, validatorSetHome, messengerHome, bridgeHome;
  let registrySpoke, validatorSetSpoke, messengerSpoke, bridgeSpoke;
  let owner, v1, v2, alice, bob, thisChainId;
  const OTHER_SPOKE_LABEL = 999001;

  async function captureSentMessage(messenger, tx) {
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((l) => { try { return messenger.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MessageSent");
    return { messageId: event.args.messageId, message: toPlainMessage(event.args.message) };
  }

  async function signThreshold(messageId) {
    return [await signRaw(v1, messageId), await signRaw(v2, messageId)];
  }

  beforeEach(async function () {
    [owner, v1, v2, alice, bob] = await ethers.getSigners();
    thisChainId = (await ethers.provider.getNetwork()).chainId;

    const InayaToken = await ethers.getContractFactory("InayaToken");
    inaya = await InayaToken.deploy();
    await inaya.waitForDeployment();
    // owner starts with 5,000,000 INAYA from the constructor's initial mint; top up further.
    await inaya.mint(owner.address, 1000);

    // ---- Home side ----
    const Registry = await ethers.getContractFactory("InayaChainRegistry");
    registryHome = await Registry.deploy(owner.address);
    await registryHome.waitForDeployment();

    const ValidatorSet = await ethers.getContractFactory("InayaValidatorSet");
    validatorSetHome = await ValidatorSet.deploy(owner.address, [v1.address, v2.address], 2);
    await validatorSetHome.waitForDeployment();

    const Messenger = await ethers.getContractFactory("InayaMessenger");
    messengerHome = await Messenger.deploy(owner.address, await registryHome.getAddress(), await validatorSetHome.getAddress());
    await messengerHome.waitForDeployment();

    const BridgeHome = await ethers.getContractFactory("InayaTokenBridgeHome");
    bridgeHome = await BridgeHome.deploy(owner.address, await inaya.getAddress(), await messengerHome.getAddress());
    await bridgeHome.waitForDeployment();

    // ---- Spoke side ----
    registrySpoke = await Registry.deploy(owner.address);
    await registrySpoke.waitForDeployment();

    validatorSetSpoke = await ValidatorSet.deploy(owner.address, [v1.address, v2.address], 2);
    await validatorSetSpoke.waitForDeployment();

    messengerSpoke = await Messenger.deploy(owner.address, await registrySpoke.getAddress(), await validatorSetSpoke.getAddress());
    await messengerSpoke.waitForDeployment();

    const Wrapped = await ethers.getContractFactory("InayaWrappedINAYA");
    wrapped = await Wrapped.deploy(owner.address, owner.address); // placeholder bridge, fixed up below
    await wrapped.waitForDeployment();

    const BridgeSpoke = await ethers.getContractFactory("InayaTokenBridgeSpoke");
    bridgeSpoke = await BridgeSpoke.deploy(
      owner.address,
      await wrapped.getAddress(),
      await messengerSpoke.getAddress(),
      thisChainId, // homeChainId label
      ethers.zeroPadValue(await bridgeHome.getAddress(), 32)
    );
    await bridgeSpoke.waitForDeployment();
    await wrapped.setBridge(await bridgeSpoke.getAddress());

    // ---- Wiring ----
    await messengerHome.setAuthorizedSender(await bridgeHome.getAddress(), true);
    await messengerHome.setHandler(MSG_TOKEN_BURN_NOTICE, await bridgeHome.getAddress());
    await messengerSpoke.setAuthorizedSender(await bridgeSpoke.getAddress(), true);
    await messengerSpoke.setHandler(MSG_TOKEN_MINT, await bridgeSpoke.getAddress());

    await registryHome.registerRemoteChain(thisChainId, FAMILY_EVM, "spoke (test)");
    await registryHome.setTrustedRemoteContract(thisChainId, ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32), true);
    await registrySpoke.registerRemoteChain(thisChainId, FAMILY_EVM, "home (test)");
    await registrySpoke.setTrustedRemoteContract(thisChainId, ethers.zeroPadValue(await bridgeHome.getAddress(), 32), true);

    await bridgeHome.setSpokeBridgeAddress(thisChainId, ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32));
    // A second, purely-labeled "spoke" for testing the ROUTE branch without deploying a full
    // second bridge contract set -- see the ROUTE test below.
    await bridgeHome.setSpokeBridgeAddress(OTHER_SPOKE_LABEL, ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32));
    await registryHome.registerRemoteChain(OTHER_SPOKE_LABEL, FAMILY_EVM, "other spoke label (test)");
  });

  async function topUpBuffer(amount) {
    // Every InayaToken transferFrom deducts an EXTRA transferFee from the caller on top of
    // `amount` -- topUpFeeBuffer is no exception, so the approval must cover amount + fee too.
    await inaya.approve(await bridgeHome.getAddress(), amount + TRANSFER_FEE);
    await bridgeHome.topUpFeeBuffer(amount);
  }

  async function bridgeOutToSpoke(from, recipient, amount) {
    await inaya.connect(from).approve(await bridgeHome.getAddress(), amount + TRANSFER_FEE);
    const tx = await bridgeHome.connect(from).bridgeOut(thisChainId, ethers.zeroPadValue(recipient, 32), amount);
    return captureSentMessage(messengerHome, tx);
  }

  describe("home -> spoke: bridgeOut + mint", function () {
    it("locks real INAYA on home and mints wrapped INAYA on spoke", async function () {
      const amount = 100n * ONE_INAYA;
      const { messageId, message } = await bridgeOutToSpoke(owner, alice.address, amount);

      expect(await bridgeHome.lockedBalanceByChain(thisChainId)).to.equal(amount);
      expect(await bridgeHome.totalLocked()).to.equal(amount);

      const sigs = await signThreshold(messageId);
      await expect(messengerSpoke.executeMessage(message, sigs)).to.emit(bridgeSpoke, "MintedFromMessage");

      expect(await wrapped.balanceOf(alice.address)).to.equal(amount);
      // Invariant: wrapped supply never exceeds what's actually locked backing it.
      expect(await wrapped.totalSupply()).to.be.lte(await bridgeHome.lockedBalanceByChain(thisChainId));
    });

    it("rejects bridgeOut to a chain with no registered spoke bridge address", async function () {
      await inaya.approve(await bridgeHome.getAddress(), ONE_INAYA + TRANSFER_FEE);
      await expect(
        bridgeHome.bridgeOut(424242, ethers.zeroPadValue(alice.address, 32), ONE_INAYA)
      ).to.be.revertedWith("No spoke bridge registered for destination chain");
    });

    it("rejects a mint message from a msgType other than TOKEN_MINT reaching the spoke bridge's handler directly is moot -- Messenger only ever routes TOKEN_MINT to it; verify onMessage itself still checks msgType defensively", async function () {
      // Impersonate the spoke messenger to call onMessage directly with the wrong msgType.
      await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [await messengerSpoke.getAddress()] });
      await hre.network.provider.request({ method: "hardhat_setBalance", params: [await messengerSpoke.getAddress(), "0x1000000000000000"] });
      const messengerSigner = await ethers.getSigner(await messengerSpoke.getAddress());

      const badMessage = {
        sourceChainId: thisChainId,
        sourceContract: ethers.zeroPadValue(await bridgeHome.getAddress(), 32),
        destChainId: thisChainId,
        destContract: ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32),
        nonce: 1,
        msgType: MSG_TOKEN_BURN_NOTICE, // wrong type for this handler
        payload: "0x",
      };
      await expect(bridgeSpoke.connect(messengerSigner).onMessage(badMessage)).to.be.revertedWith("Unexpected msgType");
    });
  });

  describe("spoke -> home: bridgeToHome (burn) + unlock (PLAIN)", function () {
    it("reverts (Failed, retryable) when the fee buffer can't cover the unlock's transfer fee, then succeeds once topped up", async function () {
      const amount = 50n * ONE_INAYA;
      const { message: mintMsg, messageId: mintId } = await bridgeOutToSpoke(owner, alice.address, amount);
      await messengerSpoke.executeMessage(mintMsg, await signThreshold(mintId));

      // bridgeHome's real INAYA balance is now exactly `amount` (== totalLocked), no fee buffer.
      const burnTx = await bridgeSpoke.connect(alice).bridgeToHome(ethers.zeroPadValue(bob.address, 32), amount);
      const { messageId: burnId, message: burnMsg } = await captureSentMessage(messengerSpoke, burnTx);
      const sigs = await signThreshold(burnId);

      await expect(messengerHome.executeMessage(burnMsg, sigs))
        .to.emit(messengerHome, "MessageFailed");
      expect(await messengerHome.getMessageStatus(burnId)).to.equal(3); // Failed
      // Accounting was rolled back by the revert inside onMessage -- still fully locked.
      expect(await bridgeHome.lockedBalanceByChain(thisChainId)).to.equal(amount);

      await topUpBuffer(TRANSFER_FEE + TRANSFER_FEE); // top up a small buffer

      await expect(messengerHome.executeMessage(burnMsg, sigs)).to.emit(messengerHome, "MessageExecuted");
      expect(await inaya.balanceOf(bob.address)).to.equal(amount);
      expect(await bridgeHome.lockedBalanceByChain(thisChainId)).to.equal(0);
    });

    it("unlocks exactly `amount` to the recipient once the fee buffer is funded", async function () {
      const amount = 50n * ONE_INAYA;
      const { message: mintMsg, messageId: mintId } = await bridgeOutToSpoke(owner, alice.address, amount);
      await messengerSpoke.executeMessage(mintMsg, await signThreshold(mintId));

      await topUpBuffer(ONE_INAYA);

      const burnTx = await bridgeSpoke.connect(alice).bridgeToHome(ethers.zeroPadValue(bob.address, 32), amount);
      const { messageId: burnId, message: burnMsg } = await captureSentMessage(messengerSpoke, burnTx);

      await messengerHome.executeMessage(burnMsg, await signThreshold(burnId));

      expect(await inaya.balanceOf(bob.address)).to.equal(amount);
      expect(await wrapped.balanceOf(alice.address)).to.equal(0);
      expect(await bridgeHome.totalLocked()).to.equal(0);
      // feeBufferBalance dropped by exactly one transferFee (the fee bridgeHome itself paid to unlock).
      expect(await bridgeHome.feeBufferBalance()).to.equal(ONE_INAYA - TRANSFER_FEE);
    });
  });

  describe("spoke -> home: bridgeToSpoke (ROUTE)", function () {
    it("re-locks under the new chain label and forwards a fresh TOKEN_MINT, with totalLocked unchanged", async function () {
      const amount = 30n * ONE_INAYA;
      const { message: mintMsg, messageId: mintId } = await bridgeOutToSpoke(owner, alice.address, amount);
      await messengerSpoke.executeMessage(mintMsg, await signThreshold(mintId));

      const totalBefore = await bridgeHome.totalLocked();

      const routeTx = await bridgeSpoke.connect(alice).bridgeToSpoke(OTHER_SPOKE_LABEL, ethers.zeroPadValue(bob.address, 32), amount);
      const { messageId: routeMsgId, message: routeMsg } = await captureSentMessage(messengerSpoke, routeTx);

      await expect(messengerHome.executeMessage(routeMsg, await signThreshold(routeMsgId)))
        .to.emit(bridgeHome, "Routed")
        .withArgs(thisChainId, OTHER_SPOKE_LABEL, amount, anyValue);

      expect(await bridgeHome.lockedBalanceByChain(thisChainId)).to.equal(0);
      expect(await bridgeHome.lockedBalanceByChain(OTHER_SPOKE_LABEL)).to.equal(amount);
      expect(await bridgeHome.totalLocked()).to.equal(totalBefore); // net zero -- re-labeled, not created/destroyed
    });

    it("rejects bridging to the home chain via bridgeToSpoke", async function () {
      await expect(bridgeSpoke.connect(alice).bridgeToSpoke(thisChainId, ethers.zeroPadValue(bob.address, 32), ONE_INAYA)).to.be.revertedWith(
        "Use bridgeToHome for the home chain"
      );
    });
  });

  describe("InayaWrappedINAYA access control", function () {
    it("restricts mint/burn to the bridge only", async function () {
      await expect(wrapped.connect(alice).mint(alice.address, ONE_INAYA)).to.be.revertedWith("Caller is not the bridge");
      await expect(wrapped.connect(alice).burn(alice.address, ONE_INAYA)).to.be.revertedWith("Caller is not the bridge");
    });

    it("restricts setBridge to the owner", async function () {
      await expect(wrapped.connect(alice).setBridge(alice.address)).to.be.revertedWithCustomError(
        wrapped,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Pause scoping", function () {
    it("pausing the home bridge blocks bridgeOut and inbound onMessage, without touching the spoke bridge", async function () {
      await bridgeHome.pauseCrossChain();
      await inaya.approve(await bridgeHome.getAddress(), ONE_INAYA + TRANSFER_FEE);
      await expect(bridgeHome.bridgeOut(thisChainId, ethers.zeroPadValue(alice.address, 32), ONE_INAYA)).to.be.revertedWithCustomError(
        bridgeHome,
        "EnforcedPause"
      );

      // Spoke-side operations are entirely unaffected by home's pause.
      await bridgeHome.unpauseCrossChain();
      const { messageId, message } = await bridgeOutToSpoke(owner, alice.address, ONE_INAYA);
      await messengerSpoke.executeMessage(message, await signThreshold(messageId));
      expect(await wrapped.balanceOf(alice.address)).to.equal(ONE_INAYA);
    });
  });
});
