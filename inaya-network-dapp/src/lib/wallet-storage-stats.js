// src/lib/wallet-storage-stats.js
//
// A local port of custody-sdk's Analytics.getWalletStorageStats() —
// NOT a duplicate written from scratch. custody-sdk/ is deliberately
// excluded from this repo's git history (it's a separately hosted repo,
// see .gitignore), which broke the original design of importing it
// directly across repos: that import resolved locally (both folders
// happen to sit on the same disk in dev) but doesn't exist at all on
// Vercel's build server, since custody-sdk/ was never actually part of
// this repo's checkout. Same on-chain reconciliation, same honesty
// rules (totalBytesStored is null, never a fabricated partial sum, if
// any file's size is unknown) as the original — see
// custody-sdk/src/analytics.js for the fuller writeup of why those
// constraints exist (no on-chain enumeration, no on-chain file-size
// field on InayaCustody).
//
// Queries metadata_files directly via Mongo rather than round-tripping
// through /api/metadata/list-files over HTTP, since this already runs
// server-side — no reason to make an HTTP call to itself.

import { ethers } from "ethers";
import { connectToDatabase } from "./mongodb";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const INAYA_CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";
const CUSTODY_ASSETS_ABI = ["function assets(bytes32) public view returns (address owner, string shardACID, string shardBCID, uint256 timestamp)"];

function toDayKey(date) {
  return date.toISOString().slice(0, 10);
}
function toWeekStartKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
function bucketTimestamps(dates) {
  const daily = new Map();
  const weekly = new Map();
  for (const date of dates) {
    const dayKey = toDayKey(date);
    const weekKey = toWeekStartKey(date);
    daily.set(dayKey, (daily.get(dayKey) || 0) + 1);
    weekly.set(weekKey, (weekly.get(weekKey) || 0) + 1);
  }
  const sortEntries = (map, keyName) =>
    [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => ({ [keyName]: key, count }));
  return { daily: sortEntries(daily, "date"), weekly: sortEntries(weekly, "weekStart") };
}

/** Same shape and honesty behavior as custody-sdk's Analytics.getWalletStorageStats(). */
export async function getWalletStorageStats(address) {
  const { db } = await connectToDatabase();
  const files = await db.collection("metadata_files").find({ owner: address.toLowerCase(), deletedAt: null }).toArray();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(INAYA_CUSTODY_ADDRESS, CUSTODY_ASSETS_ABI, provider);

  const reconciled = [];
  const unreconciled = [];

  for (const file of files) {
    try {
      const [owner, , , timestamp] = await contract.assets(file.fileHash);
      if (owner === ethers.ZeroAddress) {
        unreconciled.push({ fileHash: file.fileHash, reason: "no matching asset found on-chain" });
        continue;
      }
      if (owner.toLowerCase() !== address.toLowerCase()) {
        unreconciled.push({ fileHash: file.fileHash, reason: "on-chain owner does not match the queried address" });
        continue;
      }
      reconciled.push({ ...file, onChainTimestamp: Number(timestamp) });
    } catch (err) {
      unreconciled.push({ fileHash: file.fileHash, reason: `on-chain read failed: ${err.message}` });
    }
  }

  let totalBytesStored = 0;
  let bytesUnavailableCount = 0;
  for (const file of reconciled) {
    if (file.fileSizeBytes === null || file.fileSizeBytes === undefined) bytesUnavailableCount++;
    else totalBytesStored += file.fileSizeBytes;
  }

  const activityDates = reconciled.map((f) => new Date(f.onChainTimestamp * 1000));
  const mostRecentActivity = activityDates.length ? new Date(Math.max(...activityDates.map((d) => d.getTime()))) : null;

  return {
    address,
    totalFilesStored: reconciled.length,
    totalBytesStored: bytesUnavailableCount > 0 ? null : totalBytesStored,
    bytesUnavailableCount,
    mostRecentActivity: mostRecentActivity ? mostRecentActivity.toISOString() : null,
    uploadFrequency: bucketTimestamps(activityDates),
    unreconciledCount: unreconciled.length,
    unreconciled,
  };
}
