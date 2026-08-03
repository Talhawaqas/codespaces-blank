// app/api/admin/usage-overview/route.js
//
// GET /api/admin/usage-overview
//
// Totals files/bytes across every wallet with metadata_files records —
// by REUSING custody-sdk's Analytics.getWalletStorageStats() per wallet
// (real on-chain reconciliation, same honesty rules) rather than
// rebuilding the aggregation with a raw Mongo count/sum, which would
// silently drop the on-chain verification Module 2 already built.
// InayaCustody has no on-chain enumeration at all (see analytics.js's
// own module comment) — Metadata.listFiles() per owner is still the
// only source of which files exist, same constraint as the single-wallet
// case, just summed across every distinct owner instead of one.

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { connectToDatabase } from "../../../../lib/mongodb";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { Analytics } from "../../../../../custody-sdk/src/analytics.js";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const owners = await db.collection("metadata_files").distinct("owner");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const apiBaseUrl = process.env.NEXT_PUBLIC_APP_URL || "";

  const perWallet = await Promise.all(
    owners.map((address) => Analytics.getWalletStorageStats({ connection: provider, address, apiBaseUrl }))
  );

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
