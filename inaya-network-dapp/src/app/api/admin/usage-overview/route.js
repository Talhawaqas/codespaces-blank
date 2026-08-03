// app/api/admin/usage-overview/route.js
//
// GET /api/admin/usage-overview
//
// Totals files/bytes across every wallet with metadata_files records —
// via src/lib/wallet-storage-stats.js, a local port of custody-sdk's
// Analytics.getWalletStorageStats() (same on-chain reconciliation, same
// honesty rules). Originally imported custody-sdk directly across
// repos; that broke the Vercel build because custody-sdk/ is
// deliberately excluded from this repo's git history (separately
// hosted repo, see .gitignore) and so doesn't exist on the build server
// at all, even though the import resolved fine in local dev where both
// folders happen to sit on the same disk. See wallet-storage-stats.js's
// own comment for the full explanation.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { getWalletStorageStats } from "../../../../lib/wallet-storage-stats";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const owners = await db.collection("metadata_files").distinct("owner");

  const perWallet = await Promise.all(owners.map((address) => getWalletStorageStats(address)));

  let totalFilesStored = 0;
  let totalBytesStored = 0;
  let anyBytesUnavailable = false;
  let totalUnreconciled = 0;

  for (const stats of perWallet) {
    totalFilesStored += stats.totalFilesStored;
    totalUnreconciled += stats.unreconciledCount;
    if (stats.totalBytesStored === null) anyBytesUnavailable = true;
    else totalBytesStored += stats.totalBytesStored;
  }

  return NextResponse.json({
    totalWallets: owners.length,
    totalFilesStored,
    totalBytesStored: anyBytesUnavailable ? null : totalBytesStored,
    totalUnreconciledAcrossAllWallets: totalUnreconciled,
    perWallet: perWallet.map((s) => ({
      address: s.address,
      totalFilesStored: s.totalFilesStored,
      totalBytesStored: s.totalBytesStored,
      mostRecentActivity: s.mostRecentActivity,
    })),
  });
}
