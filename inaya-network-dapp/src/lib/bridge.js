// src/lib/bridge.js
//
// Cross-chain bridge backend (SOW-1). Same getXCollections/ensureXIndexes/validateXInput shape
// as every other lib file in this codebase (see src/lib/security.js).
//
// Collections:
//   bridge_transfers        -- one doc per cross-chain transfer/stake/unstake/claim message,
//                               _id = messageHash (mirrors executedMessages[messageHash] on-chain)
//   bridge_validator_sigs   -- signatures collected per messageHash before quorum is reached
//   bridge_chain_cursors    -- { chainId, lastProcessedBlock, updatedAt } per chain, indexer bookmark

import { connectToDatabase } from "./mongodb";
import { ethers } from "ethers";

export async function getBridgeCollections() {
  const { db } = await connectToDatabase();
  return {
    transfers: db.collection("bridge_transfers"),
    validatorSigs: db.collection("bridge_validator_sigs"),
    chainCursors: db.collection("bridge_chain_cursors"),
  };
}

let indexesEnsured = false;
export async function ensureBridgeIndexes() {
  if (indexesEnsured) return;
  const { transfers, chainCursors } = await getBridgeCollections();
  await transfers.createIndex({ status: 1, createdAt: -1 });
  await transfers.createIndex({ userAddress: 1, createdAt: -1 });
  await transfers.createIndex({ recipientAddress: 1, createdAt: -1 });
  await chainCursors.createIndex({ chainId: 1 }, { unique: true });
  indexesEnsured = true;
}

export function normalizeAddress(address) {
  if (typeof address !== "string") throw new Error("Address must be a string");
  return address.trim().toLowerCase();
}

export function validateTransferInput({ sourceChainId, destChainId, amount, userAddress }) {
  if (!Number.isFinite(Number(sourceChainId)) || !Number.isFinite(Number(destChainId))) {
    throw new Error("sourceChainId/destChainId must be numeric");
  }
  if (!amount || BigInt(amount) <= 0n) {
    throw new Error("amount must be a positive integer (wei string)");
  }
  if (!ethers.isAddress(userAddress)) {
    throw new Error("userAddress is not a valid address");
  }
}

export { hashBridgeMessage, verifyMessageOnSource } from "./bridgeMessage.js";

const MSG_TOKEN_MINT = 0; // contracts/bridge/InayaBridgeTypes.sol -- payload = abi.encode(bytes32 recipient, uint256 amount)

/** For a dest-bound token message (transfer completion, unstake payout, claim payout) returns the
 *  recipient address and amount encoded in its payload; null for any other message type or a payload
 *  that doesn't decode. Only call with a message already confirmed to hash to its id. */
export function decodeTokenPayload(message) {
  try {
    if (!message || Number(message.msgType) !== MSG_TOKEN_MINT) return null;
    const [recipient, amount] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "uint256"], message.payload);
    const hex = String(recipient);
    // an EVM recipient is a left-padded 20-byte address; anything else (e.g. a Solana key) isn't an address
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(hex)) return { recipientAddress: null, amount: amount.toString() };
    return { recipientAddress: "0x" + hex.slice(26).toLowerCase(), amount: amount.toString() };
  } catch {
    return null;
  }
}
import { hashBridgeMessage } from "./bridgeMessage.js";

/**
 * Records a transfer for status tracking.
 *
 * Client-supplied data (the public /initiate-transfer, /unstake, /claim routes) is UNTRUSTED (SQA-005): it may only CREATE a
 * pending document, never modify an existing one (previously an upsert let anyone overwrite the message, amount and status of any
 * transfer, including resetting a completed one), and a message is kept only if it hashes to its id. Whether the source chain
 * really emitted it is decided separately by verifyMessageOnSource / the event indexer, which pass { verified: true }.
 */
export async function recordTransferInitiated(doc, { verified = false } = {}) {
  await ensureBridgeIndexes();
  const { transfers } = await getBridgeCollections();
  const now = new Date();
  let message = doc.message || null;
  if (message) { try { if (hashBridgeMessage(message).toLowerCase() !== String(doc.messageHash).toLowerCase()) message = null; } catch { message = null; } }
  // The message is only kept when it hashes to its id, so what its payload says is trustworthy: use it
  // for the recipient (history by wallet) and, for a backfilled transfer that has no amount, the real amount.
  const decoded = message ? decodeTokenPayload(message) : null;
  const insert = {
    sourceChainId: doc.sourceChainId,
    destChainId: doc.destChainId,
    amount: (!doc.amount || doc.amount === "0") && decoded ? decoded.amount : doc.amount,
    recipientAddress: decoded?.recipientAddress || null,
    userAddress: normalizeAddress(doc.userAddress),
    sourceTxHash: doc.sourceTxHash,
    kind: doc.kind || "transfer", // 'transfer' | 'stake' | 'unstake' | 'claim' | 'backfill'
    status: "pending",
    sourceVerified: false,
    createdAt: now,
  };
  if (!verified) {
    // `message` only ever lands on insert; it is not relayed until the source chain confirms it
    await transfers.updateOne({ _id: doc.messageHash }, { $setOnInsert: { ...insert, message, updatedAt: now } }, { upsert: true });
    return;
  }
  // verified by the source chain: attach the CHAIN's message, never lower an existing status, never touch amount/userAddress of a known doc
  const { sourceVerified, sourceTxHash, ...insertOnly } = insert; void sourceVerified; void sourceTxHash;
  await transfers.updateOne(
    { _id: doc.messageHash },
    { $set: { message, sourceVerified: true, verifiedAt: now, updatedAt: now, ...(doc.sourceTxHash ? { sourceTxHash: doc.sourceTxHash } : {}) }, $setOnInsert: insertOnly },
    { upsert: true }
  );
}

export async function markTransferStatus(messageHash, status, extra = {}) {
  const { transfers } = await getBridgeCollections();
  await transfers.updateOne({ _id: messageHash }, { $set: { status, updatedAt: new Date(), ...extra } });
}

export async function getTransferStatus(messageHash) {
  const { transfers } = await getBridgeCollections();
  return transfers.findOne({ _id: messageHash });
}

export async function getPendingTransfersWithMessage(limit = 50) {
  const { transfers } = await getBridgeCollections();
  return transfers
    .find({ status: { $in: ["pending", "validating"] }, message: { $ne: null } }) // unverified docs are verified against the source chain by the relayer before signing
    .limit(limit)
    .toArray();
}

/** Transfers a wallet sent OR is the recipient of (a transfer picked up from the chain by the indexer
 *  has no known sender, but its recipient is decoded from the message). */
export async function getTransfersForUser(userAddress, limit = 50) {
  const { transfers } = await getBridgeCollections();
  const address = normalizeAddress(userAddress);
  return transfers
    .find({ $or: [{ userAddress: address }, { recipientAddress: address }] })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function getChainCursor(chainId) {
  const { chainCursors } = await getBridgeCollections();
  const doc = await chainCursors.findOne({ chainId: Number(chainId) });
  return doc?.lastProcessedBlock ?? 0;
}

export async function setChainCursor(chainId, blockNumber) {
  const { chainCursors } = await getBridgeCollections();
  await chainCursors.updateOne(
    { chainId: Number(chainId) },
    { $set: { lastProcessedBlock: blockNumber, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function recordValidatorSignature(messageHash, validatorAddress, signature) {
  const { validatorSigs } = await getBridgeCollections();
  await validatorSigs.updateOne(
    { messageHash, validatorAddress: normalizeAddress(validatorAddress) },
    { $set: { signature, createdAt: new Date() } },
    { upsert: true }
  );
}

export async function getSignaturesFor(messageHash) {
  const { validatorSigs } = await getBridgeCollections();
  const docs = await validatorSigs.find({ messageHash }).toArray();
  return docs.map((d) => d.signature);
}
