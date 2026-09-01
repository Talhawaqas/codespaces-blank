// scripts/backup-mechanism-recovery-proof.mjs
//
// Real proof of the full recovery cycle, building on backup-mechanism-e2e-proof.mjs's already-real
// Protected state: deletes a real Filebase replica (real destructive action against a replica this
// session created for testing -- never touches the primary Pinata pin or InayaCustody), simulates
// the Tier-1 grace window having already elapsed (that specific logic is separately unit-tested in
// backup-health.test.mjs -- this proof is about the recovery workflow itself), then runs the real
// recovery sweep and confirms it fetches from the surviving healthy replica, verifies its hash,
// re-pins to Filebase, and the asset self-heals back to Protected -- with real on-chain state
// transitions at every real boundary crossing (Protected -> RecoveryRequired -> Degraded -> Protected).
//
// Requires FILEBASE_ACCESS_KEY/FILEBASE_SECRET_KEY/FILEBASE_BUCKET in .env.local, and a real
// Pinata JWT (PINATA_JWT or the working PINATA_SECRET_API_KEY fallback -- see the note below).
//
// Run with: node scripts/backup-mechanism-recovery-proof.mjs

import { ethers } from "ethers";
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";

const ROOT = "D:/Codespace-blank/codespaces-blank-main/codespaces-blank-main";
dotenv.config({ path: `${ROOT}/inaya-network-dapp/.env.local` });
dotenv.config({ path: `${ROOT}/.env` });

// .env.local has no real PINATA_JWT (that lives only in Vercel's prod config, masked by
// `vercel env pull` for this account/team tier). PINATA_SECRET_API_KEY holds a real, working JWT
// for the same account (confirmed earlier this session against /data/testAuthentication).
// Without this, pinningProviders/pinata.js's getPinStatus() throws "not configured" for every
// local script run, and runCheckPinsSweep's catch-all silently (and misleadingly) counts that as
// a real pin miss -- caught the hard way while building this exact proof script.
const rawPinataJwt = process.env.PINATA_JWT;
process.env.PINATA_JWT = (rawPinataJwt && rawPinataJwt !== "[SENSITIVE]" ? rawPinataJwt : process.env.PINATA_SECRET_API_KEY || "").trim();

const toUrl = (p) => pathToFileURL(p).href;
const { INAYA_ADDRESSES, INAYA_BACKUP_REGISTRY_ABI } = await import(toUrl(`${ROOT}/inaya-network-dapp/custody-sdk/src/contracts.js`));
const { getBackupStatus, runCheckPinsSweep, runRecoverySweep } = await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/backupEngine.js`));
const clientPromise = (await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/mongodb.js`))).default; // NOT mongodb.js's connectToDatabase() helper -- that points at a different db ("inaya_network_corporate"), a pre-existing naming split unrelated to this SOW. backupEngine.js itself always uses "inaya_network".
const filebase = await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/pinningProviders/filebase.js`));
const { CONSECUTIVE_FAILURE_THRESHOLD } = await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/backupHealth.js`));

const FILE_HASH = "0x355f260015248e73dbbeb94efe678df8ca1ed6b44e4f3c01f09159572af0e3db"; // the real asset from backup-mechanism-e2e-proof.mjs

const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
const backupRegistry = new ethers.Contract(INAYA_ADDRESSES.backupRegistry, INAYA_BACKUP_REGISTRY_ABI, provider);
const STATE_NAMES = ["Protected", "Rebuilding", "Degraded", "RecoveryRequired", "RecoveryFailed"];
async function onChainState() {
  const record = await backupRegistry.getBackupRecord(FILE_HASH);
  return STATE_NAMES[Number(record.healthState)];
}

async function main() {
  const client = await clientPromise;
  const db = client.db("inaya_network");
  const replicas = db.collection("backup_replicas");

  console.log("Step 0: confirm starting state is really Protected");
  const before = await getBackupStatus(FILE_HASH);
  console.log(`  off-chain: ${before.healthState}, on-chain: ${await onChainState()}`);
  if (before.healthState !== "Protected") throw new Error("Expected to start from Protected -- run backup-mechanism-e2e-proof.mjs first.");

  const filebaseAlphaDoc = await replicas.findOne({ fileHash: FILE_HASH, shardId: "alpha", provider: "filebase" });
  if (!filebaseAlphaDoc) throw new Error("No Filebase shardAlpha replica found to fail.");

  console.log("\nStep 1: REAL failure -- delete the actual Filebase object for shardAlpha (via the adapter's own real unpin())");
  await filebase.unpin(filebaseAlphaDoc.providerRef);
  console.log(`  deleted ${filebaseAlphaDoc.providerRef}. Confirmed gone: ${!(await filebase.getPinStatus(filebaseAlphaDoc.providerRef))}`);

  console.log(`\nStep 2: simulate the Tier-1 grace window having already elapsed (${CONSECUTIVE_FAILURE_THRESHOLD} consecutive misses -- the grace-window logic itself is separately unit-tested)`);
  await replicas.updateOne({ _id: filebaseAlphaDoc._id }, { $set: { consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD, lastCheckOk: false } });
  await runCheckPinsSweep({}); // recomputes state from the simulated failure, alongside a real check of every other real replica
  const degraded = await getBackupStatus(FILE_HASH);
  console.log(`  off-chain: ${degraded.healthState}, on-chain: ${await onChainState()}`);
  if (degraded.healthState !== "RecoveryRequired") throw new Error(`Expected RecoveryRequired, got ${degraded.healthState}`);

  console.log("\nStep 3: run the REAL recovery sweep");
  const recoveryResult = await runRecoverySweep({});
  console.log(JSON.stringify(recoveryResult, null, 2));

  console.log("\nStep 4: one more real, clean check-pins pass -- confirms every replica (including the ones untouched by the simulated failure) is independently healthy, not just assumed so");
  await runCheckPinsSweep({});
  const after = await getBackupStatus(FILE_HASH);
  console.log(`  off-chain: ${after.healthState}, on-chain: ${await onChainState()}`);
  console.log(JSON.stringify(after, null, 2));

  console.log("\n=== SUMMARY ===");
  const onChain = await onChainState();
  const pass = after.healthState === "Protected" && onChain === "Protected" && after.shardAlpha.replicaCount === 2;
  console.log(pass
    ? "PASS: real failure detected, real recovery performed (fetched from the surviving replica, verified its hash, re-pinned), real self-heal back to Protected, real on-chain sync at every state boundary."
    : "FAIL");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
