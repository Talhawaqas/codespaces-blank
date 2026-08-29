// Test/CrossChainIntegration.test.js
//
// Run with: npx hardhat test Test/CrossChainIntegration.test.js
//
// Full end-to-end scenarios across the entire bridge + cross-chain staking stack, with every
// contract from Phase 1 wired together exactly as a real deployment would be.
//
// SIMULATION LIMITATION (same as Test/InayaTokenBridge.test.js): home and "spoke" both run on
// one real Hardhat Network chainid. Each side gets its own Messenger/ChainRegistry/
// ValidatorSet, and the numeric chain-id LABEL used throughout is `thisChainId` so
// executeMessage's `destChainId == block.chainid` check is satisfiable on both sides. This
// validates every contract's real logic and the full message/signature scheme precisely, but is
// not a substitute for the real multi-testnet dry run planned for Phase 2.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const MSG_TOKEN_MINT = 0;
const MSG_TOKEN_BURN_NOTICE = 1;
const MSG_STAKE_REQUEST = 2;
const FAMILY_EVM = 0;

const ONE_DAY = 24 * 60 * 60;
const ONE_INAYA = ethers.parseUnits("1", 18);
const TRANSFER_FEE = 100000000000000n;

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

async function increaseTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");
}

describe("Cross-chain integration (bridge + staking, full stack)", function () {
  let inaya, wrapped;
  let registryHome, validatorSetHome, messengerHome, bridgeHome, staking, stakingGatewayHome;
  let registrySpoke, validatorSetSpoke, messengerSpoke, bridgeSpoke, stakingGatewaySpoke;
  let owner, v1, v2, alice, bob, thisChainId;

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

  async function topUpBuffer(amount) {
    await inaya.approve(await bridgeHome.getAddress(), amount + TRANSFER_FEE);
    await bridgeHome.topUpFeeBuffer(amount);
  }

  async function bridgeOutToSpoke(from, recipient, amount) {
    await inaya.connect(from).approve(await bridgeHome.getAddress(), amount + TRANSFER_FEE);
    const tx = await bridgeHome.connect(from).bridgeOut(thisChainId, ethers.zeroPadValue(recipient, 32), amount);
    const { messageId, message } = await captureSentMessage(messengerHome, tx);
    await messengerSpoke.executeMessage(message, await signThreshold(messageId));
  }

  beforeEach(async function () {
    [owner, v1, v2, alice, bob] = await ethers.getSigners();
    thisChainId = (await ethers.provider.getNetwork()).chainId;

    const InayaToken = await ethers.getContractFactory("InayaToken");
    inaya = await InayaToken.deploy();
    await inaya.waitForDeployment();
    await inaya.mint(owner.address, 10_000_000);

    const Registry = await ethers.getContractFactory("InayaChainRegistry");
    const ValidatorSet = await ethers.getContractFactory("InayaValidatorSet");
    const Messenger = await ethers.getContractFactory("InayaMessenger");

    // ---- Home (BSC Testnet stand-in) ----
    registryHome = await Registry.deploy(owner.address);
    validatorSetHome = await ValidatorSet.deploy(owner.address, [v1.address, v2.address], 2);
    messengerHome = await Messenger.deploy(owner.address, await registryHome.getAddress(), await validatorSetHome.getAddress());

    const BridgeHome = await ethers.getContractFactory("InayaTokenBridgeHome");
    bridgeHome = await BridgeHome.deploy(owner.address, await inaya.getAddress(), await messengerHome.getAddress());

    const Staking = await ethers.getContractFactory("InayaStaking");
    staking = await Staking.deploy(await inaya.getAddress(), await inaya.getAddress());

    const StakingGatewayHome = await ethers.getContractFactory("InayaStakingGatewayHome");
    stakingGatewayHome = await StakingGatewayHome.deploy(
      owner.address,
      await staking.getAddress(),
      await bridgeHome.getAddress(),
      await messengerHome.getAddress()
    );

    // ---- Spoke (Sepolia stand-in) ----
    registrySpoke = await Registry.deploy(owner.address);
    validatorSetSpoke = await ValidatorSet.deploy(owner.address, [v1.address, v2.address], 2);
    messengerSpoke = await Messenger.deploy(owner.address, await registrySpoke.getAddress(), await validatorSetSpoke.getAddress());

    const Wrapped = await ethers.getContractFactory("InayaWrappedINAYA");
    wrapped = await Wrapped.deploy(owner.address, owner.address);

    const BridgeSpoke = await ethers.getContractFactory("InayaTokenBridgeSpoke");
    bridgeSpoke = await BridgeSpoke.deploy(
      owner.address,
      await wrapped.getAddress(),
      await messengerSpoke.getAddress(),
      thisChainId,
      ethers.zeroPadValue(await bridgeHome.getAddress(), 32)
    );
    await wrapped.setBridge(await bridgeSpoke.getAddress());

    const StakingGatewaySpoke = await ethers.getContractFactory("InayaStakingGatewaySpoke");
    stakingGatewaySpoke = await StakingGatewaySpoke.deploy(
      owner.address,
      await bridgeSpoke.getAddress(),
      await messengerSpoke.getAddress(),
      thisChainId,
      ethers.zeroPadValue(await stakingGatewayHome.getAddress(), 32)
    );

    // ---- Wiring ----
    await staking.setCrossChainGateway(await stakingGatewayHome.getAddress());
    await bridgeHome.setAuthorizedModule(await stakingGatewayHome.getAddress(), true);
    await bridgeHome.setSpokeBridgeAddress(thisChainId, ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32));

    await messengerHome.setAuthorizedSender(await bridgeHome.getAddress(), true);
    await messengerHome.setHandler(MSG_TOKEN_BURN_NOTICE, await bridgeHome.getAddress());
    await messengerHome.setHandler(MSG_STAKE_REQUEST, await stakingGatewayHome.getAddress());

    await bridgeSpoke.setAuthorizedInitiator(await stakingGatewaySpoke.getAddress(), true);
    await messengerSpoke.setAuthorizedSender(await bridgeSpoke.getAddress(), true);
    await messengerSpoke.setAuthorizedSender(await stakingGatewaySpoke.getAddress(), true);
    await messengerSpoke.setHandler(MSG_TOKEN_MINT, await bridgeSpoke.getAddress());

    await registryHome.registerRemoteChain(thisChainId, FAMILY_EVM, "spoke (test)");
    await registryHome.setTrustedRemoteContract(thisChainId, ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32), true);
    await registryHome.setTrustedRemoteContract(thisChainId, ethers.zeroPadValue(await stakingGatewaySpoke.getAddress(), 32), true);

    await registrySpoke.registerRemoteChain(thisChainId, FAMILY_EVM, "home (test)");
    await registrySpoke.setTrustedRemoteContract(thisChainId, ethers.zeroPadValue(await bridgeHome.getAddress(), 32), true);

    // A second, purely-labeled destination for the withdrawTo/claimRewardTo outbound-message
    // tests below (see their comment for why they can't target `thisChainId`).
    await registryHome.registerRemoteChain(424242, FAMILY_EVM, "arbitrary withdraw-to label (test)");
    await bridgeHome.setSpokeBridgeAddress(424242, ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32));

    // Reward pool, so cross-chain claim scenarios have something real to pay out.
    // NB: InayaToken.mint(amount) takes a WHOLE-token count and scales by 1e18 internally --
    // it is not wei-denominated like transfer/approve/etc.
    const poolAmount = ethers.parseUnits("8000000", 18);
    await inaya.mint(owner.address, 8_000_000);
    await inaya.approve(await staking.getAddress(), poolAmount + TRANSFER_FEE);
    await staking.fundRewardPool(poolAmount);
    await staking.setRewardRate(poolAmount / BigInt(365 * ONE_DAY), 365);

    // Pre-funded fee buffers so home-side unlocks/re-stakes don't fail on InayaToken's per-hop
    // transfer fee -- bridgeHome's buffer covers its own unlock hop, stakingGatewayHome's covers
    // the SECOND hop (gateway -> InayaStaking) that a stake-request forward makes.
    await topUpBuffer(10n * ONE_INAYA);
    await inaya.approve(await stakingGatewayHome.getAddress(), ONE_INAYA);
    await stakingGatewayHome.topUpFeeBuffer(ONE_INAYA - TRANSFER_FEE);
  });

  it("full round trip: home -> spoke -> home nets back to the original amount", async function () {
    const amount = 200n * ONE_INAYA;
    await bridgeOutToSpoke(owner, alice.address, amount);
    expect(await wrapped.balanceOf(alice.address)).to.equal(amount);

    const burnTx = await bridgeSpoke.connect(alice).bridgeToHome(ethers.zeroPadValue(bob.address, 32), amount);
    const { messageId, message } = await captureSentMessage(messengerSpoke, burnTx);
    await messengerHome.executeMessage(message, await signThreshold(messageId));

    expect(await inaya.balanceOf(bob.address)).to.equal(amount); // exact, no fee leakage to the recipient
    expect(await wrapped.balanceOf(alice.address)).to.equal(0);
    expect(await bridgeHome.totalLocked()).to.equal(0);
  });

  describe("Cross-chain staking, full flow", function () {
    it("a spoke-originated stake lands in the SAME canonical ledger as a native home staker", async function () {
      const spokeAmount = 500n * ONE_INAYA;
      await bridgeOutToSpoke(owner, alice.address, spokeAmount);

      const stakeTx = await stakingGatewaySpoke.connect(alice).stakeCrossChain(spokeAmount, 0);
      const { messageId, message } = await captureSentMessage(messengerSpoke, stakeTx);
      await expect(messengerHome.executeMessage(message, await signThreshold(messageId))).to.emit(
        stakingGatewayHome,
        "StakeRequestProcessed"
      );

      expect(await wrapped.balanceOf(alice.address)).to.equal(0); // burned on the spoke
      expect(await staking.userStakedBalance(alice.address)).to.equal(spokeAmount);
      expect(await staking.userStakedByChain(alice.address, thisChainId)).to.equal(spokeAmount);

      // A native, same-chain staker merges into the exact same ledger.
      const homeAmount = 300n * ONE_INAYA;
      await inaya.mint(bob.address, 301); // whole-token count, +1 margin for the transfer fee
      await inaya.connect(bob).approve(await staking.getAddress(), homeAmount + TRANSFER_FEE);
      await staking.connect(bob).stake(homeAmount, 0);

      expect(await staking.totalStaked()).to.equal(spokeAmount + homeAmount);
    });

    it("same INAYA cannot be staked twice: the spoke balance is gone once burned into a stake request", async function () {
      const amount = 100n * ONE_INAYA;
      await bridgeOutToSpoke(owner, alice.address, amount);
      await stakingGatewaySpoke.connect(alice).stakeCrossChain(amount, 0);

      expect(await wrapped.balanceOf(alice.address)).to.equal(0);
      await expect(stakingGatewaySpoke.connect(alice).stakeCrossChain(amount, 0)).to.be.reverted; // nothing left to burn
    });

    // NOTE: withdrawTo/claimRewardTo below target an arbitrary distinct label (not `thisChainId`)
    // because they explicitly guard against `destChainId == block.chainid` (i.e. "use the local
    // function instead") -- a real guard that is impossible to jointly satisfy alongside the
    // spoke messenger's `destChainId == block.chainid` delivery check within a single shared
    // process (both checks compare against the SAME real chainid here). These tests therefore
    // verify the real Staking -> Gateway -> Bridge -> Messenger integration through to a
    // correctly-formed, correctly-signed OUTBOUND message, without attempting delivery -- the
    // mint/unlock-on-arrival side of that same message type is already covered by
    // Test/InayaTokenBridge.test.js's TOKEN_MINT tests, and Test/InayaStakingCrossChain.test.js
    // covers withdrawTo/claimRewardTo's home-side state changes against a mock gateway. A real
    // multi-chainid delivery dry run is Phase 2's job.
    const ARBITRARY_DEST_LABEL = 424242;

    it("cross-chain unstake: home withdrawTo debits the position and produces a correctly-signed outbound mint request", async function () {
      const amount = 400n * ONE_INAYA;
      await bridgeOutToSpoke(owner, alice.address, amount);
      const stakeTx = await stakingGatewaySpoke.connect(alice).stakeCrossChain(amount, 0);
      const { messageId: stakeId, message: stakeMsg } = await captureSentMessage(messengerSpoke, stakeTx);
      await messengerHome.executeMessage(stakeMsg, await signThreshold(stakeId));

      const destRecipient = ethers.zeroPadValue(bob.address, 32);
      const withdrawTx = await staking.connect(alice).withdrawTo(amount, ARBITRARY_DEST_LABEL, destRecipient);
      const { messageId, message } = await captureSentMessage(messengerHome, withdrawTx);

      expect(await staking.userStakedBalance(alice.address)).to.equal(0);
      expect(message.msgType).to.equal(MSG_TOKEN_MINT);
      expect(message.destChainId).to.equal(ARBITRARY_DEST_LABEL);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "uint256"], message.payload);
      expect(decoded[0]).to.equal(destRecipient);
      expect(decoded[1]).to.equal(amount);
      // Threshold signatures over this exact message genuinely verify -- proves it's a real,
      // deliverable message, not just an event with the right shape.
      const [ok] = await validatorSetSpoke.verifyThreshold(
        ethers.hashMessage(ethers.getBytes(messageId)),
        await signThreshold(messageId)
      );
      expect(ok).to.equal(true);
    });

    it("cross-chain claim: home claimRewardTo zeroes rewards and produces a correctly-signed outbound mint request", async function () {
      const amount = 1000n * ONE_INAYA;
      await bridgeOutToSpoke(owner, alice.address, amount);
      const stakeTx = await stakingGatewaySpoke.connect(alice).stakeCrossChain(amount, 0);
      const { messageId: stakeId, message: stakeMsg } = await captureSentMessage(messengerSpoke, stakeTx);
      await messengerHome.executeMessage(stakeMsg, await signThreshold(stakeId));

      await increaseTime(30 * ONE_DAY);
      const earned = await staking.earned(alice.address);
      expect(earned).to.be.gt(0);

      const destRecipient = ethers.zeroPadValue(bob.address, 32);
      const claimTx = await staking.connect(alice).claimRewardTo(ARBITRARY_DEST_LABEL, destRecipient);
      const { message } = await captureSentMessage(messengerHome, claimTx);

      expect(await staking.rewards(alice.address)).to.equal(0);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "uint256"], message.payload);
      expect(decoded[0]).to.equal(destRecipient);
      expect(decoded[1]).to.be.gte(earned);
    });
  });

  describe("Security rejections", function () {
    it("rejects replaying a captured valid transfer message", async function () {
      const amount = 50n * ONE_INAYA;
      await inaya.approve(await bridgeHome.getAddress(), amount + TRANSFER_FEE);
      const tx = await bridgeHome.bridgeOut(thisChainId, ethers.zeroPadValue(alice.address, 32), amount);
      const { messageId, message } = await captureSentMessage(messengerHome, tx);
      const sigs = await signThreshold(messageId);

      await messengerSpoke.executeMessage(message, sigs);
      expect(await wrapped.balanceOf(alice.address)).to.equal(amount);

      await expect(messengerSpoke.executeMessage(message, sigs)).to.be.revertedWith("Already executed");
      expect(await wrapped.balanceOf(alice.address)).to.equal(amount); // unchanged -- no double mint
    });

    it("rejects a message claiming to be from an unregistered sender contract", async function () {
      const forged = {
        sourceChainId: thisChainId,
        sourceContract: ethers.zeroPadValue(alice.address, 32), // never registered as trusted
        destChainId: thisChainId,
        destContract: ethers.zeroPadValue(await bridgeSpoke.getAddress(), 32),
        nonce: 1,
        msgType: MSG_TOKEN_MINT,
        payload: ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [ethers.zeroPadValue(alice.address, 32), ONE_INAYA]),
      };
      await expect(messengerSpoke.executeMessage(forged, [])).to.be.revertedWith("Untrusted sender");
    });

    it("rejects execution with fewer than the validator threshold's worth of signatures", async function () {
      const amount = 50n * ONE_INAYA;
      await inaya.approve(await bridgeHome.getAddress(), amount + TRANSFER_FEE);
      const tx = await bridgeHome.bridgeOut(thisChainId, ethers.zeroPadValue(alice.address, 32), amount);
      const { messageId, message } = await captureSentMessage(messengerHome, tx);

      await expect(messengerSpoke.executeMessage(message, [await signRaw(v1, messageId)])).to.be.revertedWith(
        "Insufficient validator signatures"
      );
    });

    it("pausing cross-chain on the staking contract never blocks local staking/withdraw/claim", async function () {
      await staking.pauseCrossChain();

      const amount = 100n * ONE_INAYA;
      await inaya.mint(bob.address, 101); // whole-token count, +1 margin for the transfer fee
      await inaya.connect(bob).approve(await staking.getAddress(), amount + TRANSFER_FEE);
      await staking.connect(bob).stake(amount, 0);
      await increaseTime(10 * ONE_DAY);
      await expect(staking.connect(bob).exit()).to.not.be.reverted;

      // But the cross-chain path IS blocked -- the spoke-side burn+send still succeeds (it has
      // no idea home is paused), but home's stakeFor is gated, so delivery lands Failed, not
      // silently lost or wrongly credited.
      await bridgeOutToSpoke(owner, alice.address, amount);
      const stakeTx = await stakingGatewaySpoke.connect(alice).stakeCrossChain(amount, 0);
      const { messageId, message } = await captureSentMessage(messengerSpoke, stakeTx);
      await messengerHome.executeMessage(message, await signThreshold(messageId));
      expect(await messengerHome.getMessageStatus(messageId)).to.equal(3); // Failed
      expect(await staking.userStakedBalance(alice.address)).to.equal(0);
    });
  });
});
