// scripts/verify-chunk.cjs
//
// Manual, on-demand version of the "Verifier Service" — Phase 3 of the implementation guide,
// but without the cron. Run this by hand to prove the full challenge -> fetch -> proof -> verify
// cycle works end-to-end before you automate it.
//
// Usage: node scripts/verify-chunk.cjs <fileHash> <leafIndex>

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const PROOF_REGISTRY_ABI = [
  "function verifyChunkProof(bytes32 fileHash, uint256 leafIndex, bytes32 leaf, bytes32[] calldata proof) external returns (bool)",
  "function getAssetProof(bytes32 fileHash) external view returns (tuple(bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed))",
  "event ProofVerified(bytes32 indexed fileHash, uint256 leafIndex, bool success, address indexed node)"
];

// --- Re-implement just enough of lib/merkle.js in plain Node (no ES modules) ---
function hashChunk(chunk) {
  return ethers.keccak256(ethers.toUtf8Bytes(chunk));
}

function getMerkleProof(layers, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let i = 0; i < layers.length - 1; i++) {
    const level = layers[i];
    const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (pairIndex < level.length) proof.push(level[pairIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

async function fetchChunkFromIPFS(cid) {
  const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
  if (!res.ok) throw new Error(`Failed to fetch chunk ${cid}: ${res.status}`);
  return res.text();
}

async function main() {
  // --- Environment Variables Safety Check ---
  if (!process.env.PROOF_REGISTRY_ADDRESS) {
    throw new Error("❌ Missing PROOF_REGISTRY_ADDRESS in your .env file!");
  }
  if (!process.env.VERIFIER_PRIVATE_KEY) {
    throw new Error("❌ Missing VERIFIER_PRIVATE_KEY in your .env file!");
  }
  if (!process.env.BSC_TESTNET_RPC) {
    throw new Error("❌ Missing BSC_TESTNET_RPC in your .env file!");
  }

  const [fileHash, leafIndexArg] = process.argv.slice(2);
  if (!fileHash || leafIndexArg === undefined) {
    console.error("Usage: node scripts/verify-chunk.cjs <fileHash> <leafIndex>");
    process.exit(1);
  }
  const leafIndex = parseInt(leafIndexArg, 10);

  // Load your own asset record store (CID array + tree layers)
  const assetStore = JSON.parse(fs.readFileSync("./asset-store.json", "utf8"));
  const asset = assetStore[fileHash];
  if (!asset) throw new Error(`No local record for fileHash ${fileHash} in asset-store.json`);

  const chunkCid = asset.chunkCids[leafIndex];
  console.log(`Fetching chunk ${leafIndex} for asset ${fileHash} from CID ${chunkCid}...`);

  const chunkText = await fetchChunkFromIPFS(chunkCid);
  const leaf = hashChunk(chunkText);
  const proof = getMerkleProof(asset.merkleTreeLayers, leafIndex);

  console.log("Computed leaf:", leaf);
  console.log("Proof:", proof);

  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
  const signer = new ethers.Wallet(process.env.VERIFIER_PRIVATE_KEY, provider);
  
  console.log("Connecting to registry contract at:", process.env.PROOF_REGISTRY_ADDRESS);
  const registry = new ethers.Contract(process.env.PROOF_REGISTRY_ADDRESS, PROOF_REGISTRY_ABI, signer);

  console.log("Submitting verifyChunkProof on-chain...");
  const tx = await registry.verifyChunkProof(fileHash, leafIndex, leaf, proof);
  const receipt = await tx.wait();

  console.log("✅ Transaction confirmed:", receipt.hash);

  const record = await registry.getAssetProof(fileHash);
  console.log("\nUpdated asset record:");
  console.log("  lastVerifiedAt:", new Date(Number(record.lastVerifiedAt) * 1000).toISOString());
  console.log("  challengesPassed:", record.challengesPassed.toString());
  console.log("  challengesFailed:", record.challengesFailed.toString());
}

main().catch((err) => {
  console.error("❌ Verification script failed:", err);
  process.exit(1);
});