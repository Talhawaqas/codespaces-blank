// src/lib/metadata-auth.js
//
// Shared signature/ownership verification for the custody-sdk Metadata
// client's sharing routes (Phase 3 Tier 1, 2026-08-03). Mirrors
// custody-sdk/examples/nextjs-metadata-api-routes.js's verifyMetadataAuth/
// verifyOnChainFileOwner line-for-line (that file is illustrative only —
// this is the real, deployed implementation) and metadata.js's own
// buildMetadataMessage()/buildShareKeypairMessage() exactly — any drift
// between this file and either of those breaks every route that uses it.

import { ethers } from "ethers";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const INAYA_CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";
const CUSTODY_ASSETS_ABI = ["function assets(bytes32) public view returns (address owner, string shardACID, string shardBCID, uint256 timestamp)"];
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Recomputes metadata.js's buildMetadataMessage() output and confirms the signature recovers
 *  to the claimed address. Throws (not returns false) so every caller fails closed by default. */
export function verifyMetadataAuth({ action, resourceId, extra, address, message, signature, timestamp }) {
  if (!address || !message || !signature || typeof timestamp !== "number") {
    throw new Error("Missing auth fields — address, message, signature, and timestamp are all required.");
  }
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new Error("Signature expired — please retry.");
  }

  const lines = ["Inaya Metadata Action", `action: ${action}`, `resourceId: ${resourceId}`];
  if (extra) for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${String(value)}`);
  lines.push(`timestamp: ${timestamp}`);
  const expectedMessage = lines.join("\n");

  if (message !== expectedMessage) {
    throw new Error("Signed message doesn't match the request fields — possible tampering.");
  }

  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Signature does not match the claimed address.");
  }
}

/** Cross-checks the signer against the REAL on-chain owner of fileHash — the actual security
 *  anchor for shareFile()/revokeShare(), same as every other file-keyed metadata action. */
export async function verifyOnChainFileOwner(fileHash, claimedAddress) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const custody = new ethers.Contract(INAYA_CUSTODY_ADDRESS, CUSTODY_ASSETS_ABI, provider);
  const [owner] = await custody.assets(fileHash);
  if (owner === ethers.ZeroAddress) throw new Error(`No asset found on-chain for fileHash "${fileHash}".`);
  if (owner.toLowerCase() !== claimedAddress.toLowerCase()) {
    throw new Error("Signer is not the on-chain owner of this file.");
  }
}

/** Folders have no on-chain anchor (see metadata.js's module comment) — ownership is only ever
 *  whatever this collection recorded at createFolder() time. Cross-checks against THAT instead
 *  of a chain read. Returns the folder doc so callers that already need it (move/delete) don't
 *  have to re-query. */
export async function verifyDbFolderOwner(db, folderId, claimedAddress) {
  const folder = await db.collection("metadata_folders").findOne({ folderId });
  if (!folder) throw new Error(`No folder found with folderId "${folderId}".`);
  if (folder.owner.toLowerCase() !== claimedAddress.toLowerCase()) {
    throw new Error("Signer is not the owner of this folder.");
  }
  return folder;
}
