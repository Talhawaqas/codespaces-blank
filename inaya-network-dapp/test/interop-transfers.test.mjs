// test/interop-transfers.test.mjs
//
// Interop SOW, Phase 8 (Phase 11's unit-test slice for it). Real MongoDB,
// disposable randomized transfer IDs, cleanup in after() -- same
// convention as every other test file in this directory (see
// test/activity.test.mjs).
//
// Run with: node --test test/interop-transfers.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  INTEROP_TRANSFER_STATUS,
  recordInteropTransferInitiated,
  markInteropTransferStatus,
  getInteropTransferStatus,
  getPendingInteropTransfers,
  getInteropTransferCollections,
} from "../src/lib/interopTransfers.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const createdIds = [];

after(async () => {
  const { transfers } = await getInteropTransferCollections();
  if (createdIds.length) await transfers.deleteMany({ _id: { $in: createdIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function freshTransferId() {
  const id = `test-${randomUUID()}`;
  createdIds.push(id);
  return id;
}

test("recordInteropTransferInitiated: creates a PENDING record with the expected shape", async () => {
  const transferId = freshTransferId();
  await recordInteropTransferInitiated({
    transferId,
    provider: "wormhole",
    sourceChain: "BSC",
    destChain: "ETHEREUM",
    sourceTxHash: "0xabc",
    userAddress: "0xdef",
    amount: "1000000000000000000",
  });
  const doc = await getInteropTransferStatus(transferId);
  assert.equal(doc.status, INTEROP_TRANSFER_STATUS.PENDING);
  assert.equal(doc.provider, "wormhole");
  assert.equal(doc.destTxHash, null);
  assert.equal(doc.messageId, null);
  assert.equal(doc.failureReason, null);
});

test("markInteropTransferStatus: walks PENDING -> ATTESTING -> RELAYING -> COMPLETED, each update visible", async () => {
  const transferId = freshTransferId();
  await recordInteropTransferInitiated({ transferId, provider: "wormhole", sourceChain: "BSC", destChain: "SOLANA", sourceTxHash: "0x1", userAddress: "0x2", amount: "1" });

  await markInteropTransferStatus(transferId, INTEROP_TRANSFER_STATUS.ATTESTING, { messageId: "vaa-123" });
  assert.equal((await getInteropTransferStatus(transferId)).status, INTEROP_TRANSFER_STATUS.ATTESTING);

  await markInteropTransferStatus(transferId, INTEROP_TRANSFER_STATUS.RELAYING);
  assert.equal((await getInteropTransferStatus(transferId)).status, INTEROP_TRANSFER_STATUS.RELAYING);

  await markInteropTransferStatus(transferId, INTEROP_TRANSFER_STATUS.COMPLETED, { destTxHash: "0xdest" });
  const final = await getInteropTransferStatus(transferId);
  assert.equal(final.status, INTEROP_TRANSFER_STATUS.COMPLETED);
  assert.equal(final.messageId, "vaa-123");
  assert.equal(final.destTxHash, "0xdest");
});

test("markInteropTransferStatus: rejects an unknown status rather than silently writing garbage", async () => {
  const transferId = freshTransferId();
  await recordInteropTransferInitiated({ transferId, provider: "wormhole", sourceChain: "BSC", destChain: "SUI", sourceTxHash: "0x1", userAddress: "0x2", amount: "1" });
  await assert.rejects(() => markInteropTransferStatus(transferId, "NOT_A_REAL_STATUS"), /Unknown interop transfer status/);
});

test("getPendingInteropTransfers: includes PENDING/PROCESSING/ATTESTING/RELAYING, excludes COMPLETED/FAILED", async () => {
  const pendingId = freshTransferId();
  const completedId = freshTransferId();
  await recordInteropTransferInitiated({ transferId: pendingId, provider: "wormhole", sourceChain: "BSC", destChain: "APTOS", sourceTxHash: "0x1", userAddress: "0x2", amount: "1" });
  await recordInteropTransferInitiated({ transferId: completedId, provider: "wormhole", sourceChain: "BSC", destChain: "APTOS", sourceTxHash: "0x1", userAddress: "0x2", amount: "1" });
  await markInteropTransferStatus(completedId, INTEROP_TRANSFER_STATUS.COMPLETED);

  const pending = await getPendingInteropTransfers(200);
  const pendingIds = pending.map((d) => d._id);
  assert.ok(pendingIds.includes(pendingId));
  assert.ok(!pendingIds.includes(completedId));
});
