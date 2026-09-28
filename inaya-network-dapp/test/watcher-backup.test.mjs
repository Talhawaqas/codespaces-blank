// test/watcher-backup.test.mjs
//
// Real end-to-end test against the actual Vercel Blob store (same
// BLOB_READ_WRITE_TOKEN this app uses in production) — SQA-038.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { del } from "@vercel/blob";
import {
  getWatcherCollections, ensureWatcherIndexes, enrollWallet,
} from "../src/lib/watcherPioneer.js";
import { runWatcherBackup, listWatcherBackups, readWatcherBackup } from "../src/lib/watcherBackup.js";
import mongoClientPromise from "../src/lib/mongodb.js";

let collections; let counterSnapshot;
const createdWallets = [];
const blobUrlsToClean = [];

before(async () => {
  await ensureWatcherIndexes();
  collections = await getWatcherCollections();
  const counter = await collections.programCounters.findOne({ _id: "global" });
  counterSnapshot = counter?.enrolledWalletCount ?? 0;
});
after(async () => {
  await collections.pioneers.deleteMany({ walletAddress: { $in: createdWallets } });
  await collections.sessions.deleteMany({ walletAddress: { $in: createdWallets } });
  await collections.programCounters.updateOne({ _id: "global" }, { $set: { enrolledWalletCount: counterSnapshot } });
  for (const url of blobUrlsToClean) {
    try { await del(url); } catch { /* best-effort cleanup */ }
  }
  const client = await mongoClientPromise;
  await client.close();
});

test("runWatcherBackup: uploads a real snapshot to Blob containing the current data", async () => {
  const w = ethers.Wallet.createRandom();
  const address = w.address.toLowerCase();
  await enrollWallet({ walletAddress: address, followedX: true, joinedTelegram: true });
  createdWallets.push(address);

  const result = await runWatcherBackup();
  blobUrlsToClean.push(result.url);

  assert.ok(result.url.startsWith("https://"), "should return a real blob URL");
  assert.ok(result.pioneers >= 1, "should have counted at least the wallet just enrolled");

  const snapshot = await readWatcherBackup(result.url);
  assert.ok(Array.isArray(snapshot.pioneers));
  const mine = snapshot.pioneers.find((p) => p.walletAddress === address);
  assert.ok(mine, "the freshly-enrolled wallet must appear in the actual uploaded snapshot");
  assert.equal(mine.totalPoints, 0);
  assert.ok(snapshot.programCounters, "should include the program counter doc");
  assert.ok(Array.isArray(snapshot.compensationLog));
});

test("listWatcherBackups: the snapshot just taken shows up in the listing", async () => {
  const result = await runWatcherBackup();
  blobUrlsToClean.push(result.url);

  const backups = await listWatcherBackups();
  const found = backups.find((b) => b.url === result.url);
  assert.ok(found, "the backup just taken should be listed");
  assert.ok(backups.length >= 1);
});
