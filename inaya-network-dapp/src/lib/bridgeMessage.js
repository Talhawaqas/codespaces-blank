// src/lib/bridgeMessage.js
//
// Pure (ethers-only, no database) bridge-message helpers, so they can be unit-tested against the real contract (Test/BridgeMessageHashParity.test.js).

import { ethers } from "ethers";

// InayaBridgeTypes.hashMessage, reproduced exactly (contracts/bridge/InayaBridgeTypes.sol).
const DOMAIN_TAG = ethers.keccak256(ethers.toUtf8Bytes("INAYA_CROSSCHAIN_V1"));
export function hashBridgeMessage(m) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "bytes32", "uint256", "bytes32", "uint256", "uint8", "bytes32"],
    [DOMAIN_TAG, m.sourceChainId, m.sourceContract, m.destChainId, m.destContract, m.nonce, m.msgType, ethers.keccak256(m.payload)]
  ));
}

const MESSAGE_SENT_IFACE = new ethers.Interface([
  "event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)",
]);

const messageOf = (m) => ({
  sourceChainId: String(m.sourceChainId), sourceContract: m.sourceContract, destChainId: String(m.destChainId), destContract: m.destContract,
  nonce: String(m.nonce), msgType: Number(m.msgType), payload: m.payload,
});

/**
 * SQA-005 (S0): the relayer's validators sign whatever message a transfer document carries, and the destination contract only
 * checks "trusted source contract + validator signatures". So a message must never be signed unless the SOURCE chain itself
 * emitted it. This looks the source transaction up on the source chain and requires a MessageSent log, from the trusted
 * messenger contract, whose messageId equals the document id AND equals the hash recomputed from the emitted message.
 * Returns { ok, message } (message is the one from the chain, never the client's) or { ok:false, reason }.
 */
export async function verifyMessageOnSource({ messageHash, sourceTxHash, provider, messengerAddress }) {
  try {
    if (!messageHash || !sourceTxHash || !provider || !messengerAddress) return { ok: false, reason: "missing verification inputs" };
    const receipt = await provider.getTransactionReceipt(sourceTxHash);
    if (!receipt) return { ok: false, reason: "source transaction not found on the source chain" };
    if (receipt.status !== 1) return { ok: false, reason: "source transaction failed on the source chain" };
    for (const log of receipt.logs || []) {
      if (String(log.address).toLowerCase() !== String(messengerAddress).toLowerCase()) continue;
      let parsed; try { parsed = MESSAGE_SENT_IFACE.parseLog(log); } catch { continue; }
      if (!parsed || parsed.name !== "MessageSent") continue;
      if (String(parsed.args.messageId).toLowerCase() !== String(messageHash).toLowerCase()) continue;
      const message = messageOf(parsed.args.message);
      if (hashBridgeMessage(message).toLowerCase() !== String(messageHash).toLowerCase()) return { ok: false, reason: "emitted message does not hash to its id" };
      return { ok: true, message };
    }
    return { ok: false, reason: "no matching MessageSent event in the source transaction" };
  } catch (err) {
    return { ok: false, reason: `source verification failed: ${err.message}` };
  }
}
