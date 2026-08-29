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

export async function recordTransferInitiated(doc) {
  await ensureBridgeIndexes();
  const { transfers } = await getBridgeCollections();
  await transfers.updateOne(
    { _id: doc.messageHash },
    {
      $set: {
        sourceChainId: doc.sourceChainId,
        destChainId: doc.destChainId,
        amount: doc.amount,
        userAddress: normalizeAddress(doc.userAddress),
        sourceTxHash: doc.sourceTxHash,
        kind: doc.kind || "transfer", // 'transfer' | 'stake' | 'unstake' | 'claim'
        // Full on-chain Message struct (sourceContract/destContract/nonce/msgType/payload) --
        // needed by the relayer cron to actually sign+submit executeMessage on the destination
        // chain. The client already has this from its transaction receipt; the indexer's
        // MessageSent backfill path populates it too.
        message: doc.message || null,
        status: "pending",
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
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
    .find({ status: { $in: ["pending", "validating"] }, message: { $ne: null } })
    .limit(limit)
    .toArray();
}

export async function getTransfersForUser(userAddress, limit = 50) {
  const { transfers } = await getBridgeCollections();
  return transfers
    .find({ userAddress: normalizeAddress(userAddress) })
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
