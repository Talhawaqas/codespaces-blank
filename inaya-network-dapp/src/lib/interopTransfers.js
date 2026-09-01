// src/lib/interopTransfers.js
//
// Interop SOW, Phase 8. Same getXCollections/ensureXIndexes shape as
// src/lib/bridge.js's bridge_transfers -- a SEPARATE collection
// (interop_transfers), not a reuse of bridge_transfers, because these
// track transfers through the Wormhole interop layer
// (src/lib/chain-adapters/interop/), not Inaya's own native bridge.
// Conflating the two would make "which system actually moved this
// $INAYA" ambiguous, which the accounting requirements in
// docs/inaya-interoperability.md explicitly rule out.
//
// _id = transferId (Inaya-generated, not the provider's own ID, so this
// collection's key is stable even if the provider is swapped later --
// the provider's own message ID/attestation is stored as a field, not
// the primary key).

import { connectToDatabase } from "./mongodb.js";

export const INTEROP_TRANSFER_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  ATTESTING: "ATTESTING",
  RELAYING: "RELAYING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

export async function getInteropTransferCollections() {
  const { db } = await connectToDatabase();
  return {
    transfers: db.collection("interop_transfers"),
  };
}

let indexesEnsured = false;
export async function ensureInteropTransferIndexes() {
  if (indexesEnsured) return;
  const { transfers } = await getInteropTransferCollections();
  await transfers.createIndex({ status: 1, createdAt: -1 });
  await transfers.createIndex({ userAddress: 1, createdAt: -1 });
  await transfers.createIndex({ provider: 1, sourceChain: 1, destChain: 1 });
  indexesEnsured = true;
}

/** @param {{ transferId: string, provider: string, sourceChain: string, destChain: string,
 *  sourceTxHash: string, userAddress: string, amount: string }} doc */
export async function recordInteropTransferInitiated(doc) {
  await ensureInteropTransferIndexes();
  const { transfers } = await getInteropTransferCollections();
  await transfers.updateOne(
    { _id: doc.transferId },
    {
      $set: {
        provider: doc.provider, // 'wormhole' today; kept as a field (not assumed) so a future
        // second provider doesn't require a schema migration -- see docs/inaya-interoperability.md
        sourceChain: doc.sourceChain,
        destChain: doc.destChain,
        sourceTxHash: doc.sourceTxHash,
        destTxHash: null,
        messageId: null, // Wormhole VAA ID / attestation, filled in once observed
        userAddress: doc.userAddress,
        amount: doc.amount,
        status: INTEROP_TRANSFER_STATUS.PENDING,
        failureReason: null,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

export async function markInteropTransferStatus(transferId, status, extra = {}) {
  if (!Object.values(INTEROP_TRANSFER_STATUS).includes(status)) {
    throw new Error(`Unknown interop transfer status: ${status}`);
  }
  const { transfers } = await getInteropTransferCollections();
  await transfers.updateOne({ _id: transferId }, { $set: { status, updatedAt: new Date(), ...extra } });
}

export async function getInteropTransferStatus(transferId) {
  const { transfers } = await getInteropTransferCollections();
  return transfers.findOne({ _id: transferId });
}

export async function getPendingInteropTransfers(limit = 50) {
  const { transfers } = await getInteropTransferCollections();
  return transfers
    .find({ status: { $in: [INTEROP_TRANSFER_STATUS.PENDING, INTEROP_TRANSFER_STATUS.PROCESSING, INTEROP_TRANSFER_STATUS.ATTESTING, INTEROP_TRANSFER_STATUS.RELAYING] } })
    .limit(limit)
    .toArray();
}
