// src/lib/walletSearch.js
//
// Enterprise OS SOW, Phase 4 — Unified Search (wallet scope). Searches
// the wallet's own vault files (metadata_files, owner-scoped — the same
// off-chain enumeration source list-files/route.js's header comment
// documents as the only place a full file list can come from at all, no
// on-chain reverse index exists). No-leak-by-construction: filtered by
// `owner`, the same field every metadata route already gates on.
//
// Deliberately NOT searching NFTs, bridge transfers, or staking history
// in this pass: NFT discovery (nftDiscovery.js's discoverOwnedTokens())
// needs a live ethers provider and a specific known contract address per
// call — it isn't a general "search all NFTs" capability today, and
// bridge/staking history lives as on-chain events with no indexer or
// off-chain mirror to query server-side. Both are real, honest gaps, not
// silently dropped — see docId ENTERPRISE_OS_PHASE4_GAPS below.

import { connectToDatabase } from "./mongodb.js";

export const WALLET_SEARCH_GAPS =
  "NFTs, bridge transfers, and staking history aren't searchable yet — NFT discovery needs a live RPC provider and a specific contract per call, and bridge/staking history has no off-chain index to query.";

/** searchWallet({walletAddress, query, limit}) */
export async function searchWallet({ walletAddress, query, limit = 20 }) {
  const trimmed = (query || "").trim();
  if (trimmed.length < 2) return [];

  const { db } = await connectToDatabase();
  const files = await db
    .collection("metadata_files")
    .find({
      owner: walletAddress.toLowerCase(),
      deletedAt: null,
      filename: { $regex: trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" },
    })
    .project({ filename: 1, fileHash: 1 })
    .limit(limit)
    .toArray();

  return files.map((f) => ({
    entityType: "file",
    id: f.fileHash,
    title: f.filename,
    subtitle: "Sovereign Vault file",
    actionUrl: "/",
  }));
}
