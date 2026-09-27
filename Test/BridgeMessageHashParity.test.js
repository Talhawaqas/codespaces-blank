// Test/BridgeMessageHashParity.test.js
//
// SQA-005: the dApp's relayer now recomputes a bridge message's id off-chain (inaya-network-dapp/src/lib/bridge.js hashBridgeMessage)
// and refuses to sign anything whose recomputed id differs. That is only safe if the off-chain formula is byte-for-byte the
// contract's InayaBridgeTypes.hashMessage, so this pins it to the REAL messageId the deployed contract emits.
//
// Run with: npx hardhat test Test/BridgeMessageHashParity.test.js

import { expect } from "chai";
import hre from "hardhat";
import { hashBridgeMessage } from "../inaya-network-dapp/src/lib/bridgeMessage.js";
const { ethers } = hre;

describe("bridge message id parity (contract vs relayer)", function () {
  it("hashBridgeMessage equals the messageId the contract emits, for several payloads", async function () {
    const [owner, sender] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const registry = await (await ethers.getContractFactory("InayaChainRegistry")).deploy(owner.address);
    const validatorSet = await (await ethers.getContractFactory("InayaValidatorSet")).deploy(owner.address, [owner.address, sender.address], 2);
    const messenger = await (await ethers.getContractFactory("InayaMessenger")).deploy(owner.address, await registry.getAddress(), await validatorSet.getAddress());
    const handler = await (await ethers.getContractFactory("MockMessageHandler")).deploy();
    await registry.registerRemoteChain(chainId, 0, "self (test)");
    await messenger.setAuthorizedSender(sender.address, true);
    const dest = ethers.zeroPadValue(await handler.getAddress(), 32);

    for (const payload of ["0x", "0x01", ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [sender.address, 123456789n])]) {
      const receipt = await (await messenger.connect(sender).sendMessage(chainId, dest, 0, payload)).wait();
      const event = receipt.logs.map((l) => { try { return messenger.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
      const m = event.args.message;
      const plain = { sourceChainId: m.sourceChainId, sourceContract: m.sourceContract, destChainId: m.destChainId, destContract: m.destContract, nonce: m.nonce, msgType: m.msgType, payload: m.payload };
      expect(hashBridgeMessage(plain)).to.equal(event.args.messageId);
      // any change to the message must change the id
      expect(hashBridgeMessage({ ...plain, nonce: plain.nonce + 1n })).to.not.equal(event.args.messageId);
      expect(hashBridgeMessage({ ...plain, payload: payload + "00" })).to.not.equal(event.args.messageId);
    }
  });
});
