// scripts/verify-phase2.cjs
//
// End-to-end verification that the mobile upload flow (UploadScreen.js) now correctly
// produces a real InayaProofRegistry registration -- replicates its exact sequence:
// InayaKernel.disperseAndSlice -> pin shards to IPFS -> InayaCustody.batchRegisterAssets ->
// reconstruct cipherText -> build Merkle root -> InayaProofRegistry.registerMerkleRoot.
//
// Run: node scripts/verify-phase2.cjs

const { ethers } = require("ethers");
require("dotenv").config();

const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";
const PROOF_REGISTRY_ADDRESS = process.env.PROOF_REGISTRY_ADDRESS;
const USDT_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D";
const INAYA_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";

const CUSTODY_ABI = [
  "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
  "function assets(bytes32) public view returns (address owner, string shardACID, string shardBCID, uint256 timestamp)",
];
const REGISTRY_ABI = [
  "function registerMerkleRoot(bytes32 _fileHash, bytes32 _merkleRoot, uint256 _chunkCount, address _node) external",
  "function getAssetProof(bytes32 _fileHash) external view returns (tuple(bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed))",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
];

// --- Same merkle.js algorithm, inlined here so this script has no dependency on the RN app tree ---
const CHUNK_SIZE = 256 * 1024;
function chunkCipherText(s) {
  const chunks = [];
  for (let i = 0; i < s.length; i += CHUNK_SIZE) chunks.push(s.slice(i, i + CHUNK_SIZE));
  return chunks;
}
function hashChunk(chunk) {
  return ethers.keccak256(ethers.toUtf8Bytes(chunk));
}
function buildMerkleTree(leaves) {
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(ethers.keccak256(ethers.concat([left, right].sort())));
    }
    level = next;
  }
  return level[0];
}
function buildProofOfStoragePayload(cipherTextString) {
  const chunks = chunkCipherText(cipherTextString);
  const leaves = chunks.map(hashChunk);
  return { root: buildMerkleTree(leaves), chunkCount: chunks.length };
}

async function pinShardToIPFS(shardContent, filename, tag, walletAddress) {
  const res = await fetch("https://www.inayanetwork.com/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptedShard: shardContent, filename, elementTag: tag, walletAddress }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || data.pinata || `Pinning failed for shard ${tag} (HTTP ${res.status})`);
  return data.IpfsHash;
}

async function main() {
  if (!PROOF_REGISTRY_ADDRESS) throw new Error("PROOF_REGISTRY_ADDRESS not set");

  const { InayaKernel } = await import("../inaya-network-dapp/custody-sdk/src/index.js");

  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545");
  const treasury = new ethers.Wallet(process.env.TREASURY_WALLET_PRIVATE_KEY, provider);
  const wallet = ethers.Wallet.createRandom().connect(provider);
  console.log("Simulated mobile uploader wallet:", wallet.address);

  console.log("\nFunding gas + requesting test tokens...");
  await (await treasury.sendTransaction({ to: wallet.address, value: ethers.parseEther("0.0008") })).wait();
  const faucetRes = await fetch("https://www.inayanetwork.com/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet.address }),
  });
  console.log("  Faucet:", JSON.stringify((await faucetRes.json()).results));

  const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
  const inaya = new ethers.Contract(INAYA_ADDRESS, ERC20_ABI, wallet);
  await (await usdt.approve(CUSTODY_ADDRESS, ethers.MaxUint256)).wait();
  await (await inaya.approve(CUSTODY_ADDRESS, ethers.MaxUint256)).wait();
  console.log("  Approvals confirmed.");

  // --- Exact UploadScreen.js sequence from here down ---
  console.log("\n--- Simulating UploadScreen.js's handleUpload() ---");
  const fileContent = `Phase 2 verification test file — ${Date.now()}`;
  const blob = new Blob([fileContent], { type: "text/plain" });
  blob.name = "phase2-test.txt";

  const passkey = "phase2-verify-passkey";
  const salt = InayaKernel.generateSecureSalt(16);
  const vaultKey = await InayaKernel.deriveVaultKey({ passkey, salt });
  const sharded = await InayaKernel.disperseAndSlice({ file: blob, encryptionKey: vaultKey });
  console.log("  Sharded OK. shardAlpha/Beta lengths:", sharded.shardAlpha.length, sharded.shardBeta.length);

  console.log("  Pinning shards to IPFS...");
  const [cidAlpha, cidBeta] = await Promise.all([
    pinShardToIPFS(sharded.shardAlpha, sharded.filename, "Alpha", wallet.address),
    pinShardToIPFS(sharded.shardBeta, sharded.filename, "Beta", wallet.address),
  ]);
  console.log("  cidAlpha:", cidAlpha, "| cidBeta:", cidBeta);

  const assetIdText = `${sharded.filename}-${Date.now()}`;
  const fileHash = ethers.id(assetIdText);
  const sizeBytes = fileContent.length;

  const custody = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, wallet);
  console.log("  Registering in InayaCustody...");
  await (await custody.batchRegisterAssets([fileHash], [sizeBytes], [cidAlpha], [cidBeta])).wait();
  const [recordedOwner] = await custody.assets(fileHash);
  console.log(`  Custody-recorded owner: ${recordedOwner} (${recordedOwner === wallet.address ? "matches ✓" : "MISMATCH ✗"})`);

  console.log("  Building Merkle root from reconstructed cipherText...");
  const cipherTextString = sharded.shardAlpha + sharded.shardBeta;
  const { root, chunkCount } = buildProofOfStoragePayload(cipherTextString);
  console.log(`  root: ${root} | chunkCount: ${chunkCount}`);

  const registry = new ethers.Contract(PROOF_REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
  console.log("  Registering Merkle root on InayaProofRegistry...");
  const rootTx = await registry.registerMerkleRoot(fileHash, root, chunkCount, ethers.ZeroAddress);
  await rootTx.wait();
  console.log("  ✅ registerMerkleRoot confirmed:", rootTx.hash);

  const proof = await registry.getAssetProof(fileHash);
  const ok =
    proof.owner === wallet.address &&
    proof.merkleRoot === root &&
    proof.chunkCount === BigInt(chunkCount);
  console.log(`\n  Stored owner: ${proof.owner} (${proof.owner === wallet.address ? "✓" : "✗"})`);
  console.log(`  Stored merkleRoot: ${proof.merkleRoot} (${proof.merkleRoot === root ? "✓" : "✗"})`);
  console.log(`  Stored chunkCount: ${proof.chunkCount} (${proof.chunkCount === BigInt(chunkCount) ? "✓" : "✗"})`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(ok ? "✅ PHASE 2 END-TO-END VERIFICATION PASSED" : "❌ PHASE 2 VERIFICATION FAILED");
  console.log("=".repeat(60));
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
