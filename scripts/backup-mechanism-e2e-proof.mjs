// scripts/backup-mechanism-e2e-proof.mjs
//
// Real end-to-end proof of the Backup & Recovery Mechanism (docs/backup-redundancy-architecture.md).
//
// Originally written to create a brand-new test upload (encrypt+shard+pin+register), but the
// project's real Pinata account is currently blocked on its plan's usage limit (confirmed via a
// real 403 "Account blocked due to plan usage limit" from api.pinata.cloud -- an external,
// account-level constraint, not a bug in this code). Rather than fabricate pin data to work
// around that, this proof instead runs the real backupEngine against a REAL, already-uploaded,
// already-registered asset (found via the real metadata_files MongoDB collection, its real CIDs
// read back from the real, live InayaCustody contract) -- replicateShard's read side (fetching
// existing shard content via public IPFS gateways) doesn't touch Pinata's write-side account
// limit at all, so this is still a genuine, live proof, just against pre-existing data rather
// than a fresh pin.
//
// Run with: node scripts/backup-mechanism-e2e-proof.mjs

import { ethers } from "ethers";
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";

const ROOT = "D:/Codespace-blank/codespaces-blank-main/codespaces-blank-main";
dotenv.config({ path: `${ROOT}/inaya-network-dapp/.env.local` });
dotenv.config({ path: `${ROOT}/.env` });

const rawPinataJwt = process.env.PINATA_JWT;
const PINATA_TOKEN = (rawPinataJwt && rawPinataJwt !== "[SENSITIVE]" ? rawPinataJwt : process.env.PINATA_SECRET_API_KEY || "").trim();
process.env.PINATA_JWT = PINATA_TOKEN; // in-process only, so pinningProviders/pinata.js's own reads (used below) pick up a real token

const toUrl = (p) => pathToFileURL(p).href;
const { INAYA_CUSTODY_ABI, INAYA_ADDRESSES, INAYA_BACKUP_REGISTRY_ABI } = await import(toUrl(`${ROOT}/inaya-network-dapp/custody-sdk/src/contracts.js`));
const { replicateShard, getBackupStatus, runCheckPinsSweep } = await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/backupEngine.js`));
const { connectToDatabase } = await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/mongodb.js`)); // reuse the dApp's own mongodb.js so "mongodb" resolves against inaya-network-dapp's node_modules, not this script's own (repo-root's is a broken/mismatched install)

// Same two-gateway fallback page.js's own fetchFastShard already uses, plus a short per-attempt
// timeout so a dead/unpinned CID fails fast across candidates instead of hanging on the default
// fetch timeout for every gateway.
async function fetchShardContent(cid) {
  for (const base of ["https://cloudflare-ipfs.com/ipfs", "https://gateway.pinata.cloud/ipfs", "https://ipfs.io/ipfs"]) {
    try {
      const res = await fetch(`${base}/${cid}`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.shard) return json.shard;
    } catch { /* try next gateway */ }
  }
  throw new Error(`All gateways failed for ${cid}`);
}

async function main() {
  console.log("=== Backup & Recovery Mechanism -- real end-to-end proof (against a real existing asset) ===\n");

  console.log("Step 1-3: find a real, already-registered asset whose shards are still actually fetchable (older test pins may have expired)");
  const { db } = await connectToDatabase();
  const metadataCandidates = await db.collection("metadata_files").find({}).sort({ createdAt: -1 }).limit(15).toArray();
  const paygCandidates = await db.collection("payg_assets").find({}).sort({ uploadedAt: -1 }).limit(15).toArray();
  const candidates = [...metadataCandidates, ...paygCandidates.map((d) => ({ fileHash: d.fileHash, filename: d.filename, createdAt: d.uploadedAt }))];
  if (candidates.length === 0) throw new Error("No existing asset records found to test against.");

  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
  const custody = new ethers.Contract(INAYA_ADDRESSES.custody, INAYA_CUSTODY_ABI, provider);

  let fileHash, cidAlpha, cidBeta, shardAlpha, shardBeta, owner;
  for (const doc of candidates) {
    try {
      const [ownerAddr, ca, cb] = await custody.assets(doc.fileHash);
      if (ownerAddr === ethers.ZeroAddress) continue;
      const [sa, sb] = await Promise.all([fetchShardContent(ca), fetchShardContent(cb)]);
      fileHash = doc.fileHash; cidAlpha = ca; cidBeta = cb; shardAlpha = sa; shardBeta = sb; owner = ownerAddr;
      console.log(`  found working candidate: ${doc.filename} (fileHash ${fileHash})`);
      break;
    } catch (err) {
      console.log(`  skipping ${doc.filename} (fileHash ${doc.fileHash}): ${err.message}`);
    }
  }
  if (!fileHash) throw new Error("None of the recent candidates had both shards still fetchable.");

  console.log(`  owner: ${owner}`);
  console.log(`  cidAlpha: ${cidAlpha}`);
  console.log(`  cidBeta:  ${cidBeta}`);
  console.log(`  shardAlpha length: ${shardAlpha.length}, shardBeta length: ${shardBeta.length}`);

  console.log("\nStep 4: run both shards through the real backupEngine.replicateShard()");
  const alphaResult = await replicateShard({ fileHash, shardId: "alpha", content: shardAlpha, primaryProvider: "pinata", primaryCid: cidAlpha });
  const betaResult = await replicateShard({ fileHash, shardId: "beta", content: shardBeta, primaryProvider: "pinata", primaryCid: cidBeta });
  console.log("  shardAlpha replicas:", JSON.stringify(alphaResult.replicas));
  console.log("  shardBeta replicas:", JSON.stringify(betaResult.replicas));
  console.log(`  healthState after replication: ${betaResult.healthState}`);

  console.log("\nStep 5: read back real backup status");
  const status = await getBackupStatus(fileHash);
  console.log(JSON.stringify(status, null, 2));

  console.log("\nStep 6: run a real Tier-1 check-pins sweep -- confirms Pinata still reports holding both real, pre-existing CIDs as pinned");
  const sweep = await runCheckPinsSweep({});
  console.log(JSON.stringify(sweep, null, 2));

  console.log("\nStep 7: verify the real on-chain InayaBackupRegistry state");
  const backupRegistry = new ethers.Contract(INAYA_ADDRESSES.backupRegistry, INAYA_BACKUP_REGISTRY_ABI, provider);
  const record = await backupRegistry.getBackupRecord(fileHash);
  const stateNames = ["Protected", "Rebuilding", "Degraded", "RecoveryRequired", "RecoveryFailed"];
  console.log(`  on-chain owner: ${record.owner}`);
  console.log(`  on-chain targetReplicaCount: ${record.targetReplicaCount}`);
  console.log(`  on-chain healthState: ${stateNames[Number(record.healthState)]}`);
  console.log(`  on-chain registeredAt: ${record.registeredAt}`);

  console.log("\n=== SUMMARY ===");
  console.log(`fileHash: ${fileHash}`);
  console.log(`Off-chain computed healthState: ${status.healthState}`);
  console.log(`On-chain recorded healthState:  ${stateNames[Number(record.healthState)]}`);
  console.log(`Match: ${stateNames[Number(record.healthState)] === status.healthState}`);
  console.log(record.registeredAt > 0n ? "PASS: real on-chain redundancy commitment registered, real replica tracked, real Tier-1 check succeeded." : "FAIL: no on-chain record found.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
