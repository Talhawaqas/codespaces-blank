// scripts/verify-fix.cjs
//
// End-to-end verification of the Phase 1 InayaProofRegistry fix, against real transactions
// on BSC Testnet -- not just code review. Run: node scripts/verify-fix.cjs
//
// Covers all four SOW verification requirements:
//   1. Front-running attack (Wallet B registers Wallet A's real fileHash) now reverts.
//   2. The legitimate owner (matching Custody's real record) can still register successfully.
//   3. The _node parameter guard behaves as intended (unregistered node rejected, registered node accepted).
//   4. address(0) for _node still works (documented "no node assigned yet" case).

const { ethers } = require("ethers");
require("dotenv").config();

const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";
const PROOF_REGISTRY_ADDRESS = process.env.PROOF_REGISTRY_ADDRESS;

const CUSTODY_ABI = [
  "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
  "function assets(bytes32) public view returns (address owner, string shardACID, string shardBCID, uint256 timestamp)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function balanceOf(address account) public view returns (uint256)",
];
const USDT_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D";
const INAYA_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";

const REGISTRY_ABI = [
  "function registerMerkleRoot(bytes32 _fileHash, bytes32 _merkleRoot, uint256 _chunkCount, address _node) external",
  "function getAssetProof(bytes32 _fileHash) external view returns (tuple(bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed))",
  "function setNodeRegistered(address _node, bool _isRegistered) external",
  "function isRegisteredNode(address) external view returns (bool)",
  "function owner() external view returns (address)",
];

function randomFileHash(label) {
  return ethers.id(`verify-fix-${label}-${Date.now()}-${Math.random()}`);
}

async function expectRevert(promiseFactory, label, expectedSubstring) {
  try {
    const tx = await promiseFactory();
    await tx.wait();
    console.log(`  ❌ FAIL (${label}): expected a revert, but the transaction succeeded`);
    return false;
  } catch (err) {
    const msg = err.reason || err.shortMessage || err.message || "";
    const matched = expectedSubstring ? msg.includes(expectedSubstring) : true;
    if (matched) {
      console.log(`  ✅ PASS (${label}): reverted as expected — "${msg}"`);
    } else {
      console.log(`  ⚠️  Reverted, but message didn't match expected substring "${expectedSubstring}": "${msg}"`);
    }
    return matched;
  }
}

async function expectSuccess(promiseFactory, label) {
  try {
    const tx = await promiseFactory();
    const receipt = await tx.wait();
    console.log(`  ✅ PASS (${label}): tx confirmed — ${receipt.hash}`);
    return true;
  } catch (err) {
    const msg = err.reason || err.shortMessage || err.message || "";
    console.log(`  ❌ FAIL (${label}): expected success, but reverted — "${msg}"`);
    return false;
  }
}

async function main() {
  if (!PROOF_REGISTRY_ADDRESS) throw new Error("PROOF_REGISTRY_ADDRESS not set in env");

  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545");
  const treasury = new ethers.Wallet(process.env.TREASURY_WALLET_PRIVATE_KEY, provider);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider); // contract owner

  // Two fresh, disposable wallets for this run -- Wallet A is the "legitimate uploader",
  // Wallet B is the "attacker" trying to front-run A's file.
  const walletA = ethers.Wallet.createRandom().connect(provider);
  const walletB = ethers.Wallet.createRandom().connect(provider);
  console.log("Wallet A (legit owner):", walletA.address);
  console.log("Wallet B (attacker):   ", walletB.address);

  console.log("\nFunding test wallets from treasury...");
  const fundAmount = ethers.parseEther("0.0006");
  for (const w of [walletA, walletB]) {
    const tx = await treasury.sendTransaction({ to: w.address, value: fundAmount });
    await tx.wait();
  }
  console.log("  Funded both wallets with", ethers.formatEther(fundAmount), "tBNB each.");

  const custodyAsA = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, walletA);
  const registryAsA = new ethers.Contract(PROOF_REGISTRY_ADDRESS, REGISTRY_ABI, walletA);
  const registryAsB = new ethers.Contract(PROOF_REGISTRY_ADDRESS, REGISTRY_ABI, walletB);
  const registryAsOwner = new ethers.Contract(PROOF_REGISTRY_ADDRESS, REGISTRY_ABI, deployer);

  let allPassed = true;

  // --- Setup: give Wallet A test tokens (batchRegisterAssets charges a per-file fee) and approve Custody to pull them ---
  console.log("\nRequesting test tokens for Wallet A from the faucet...");
  const faucetRes = await fetch("https://www.inayanetwork.com/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: walletA.address }),
  });
  const faucetData = await faucetRes.json();
  console.log("  Faucet response:", JSON.stringify(faucetData.results || faucetData));

  console.log("Approving InayaCustody to spend Wallet A's mUSDT and $INAYA...");
  const maxApproval = ethers.MaxUint256;
  const usdtAsA = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, walletA);
  const inayaAsA = new ethers.Contract(INAYA_ADDRESS, ERC20_ABI, walletA);
  await (await usdtAsA.approve(CUSTODY_ADDRESS, maxApproval)).wait();
  await (await inayaAsA.approve(CUSTODY_ADDRESS, maxApproval)).wait();
  console.log("  Approvals confirmed.");

  // --- Setup: Wallet A registers a REAL asset in InayaCustody ---
  console.log("\n--- Setup: Wallet A registers a real asset in InayaCustody ---");
  const fileHash1 = randomFileHash("test1");
  const setupTx = await custodyAsA.batchRegisterAssets(
    [fileHash1],
    [12345],
    ["bafytestshardA00000000000000000000000000000000000000000001"],
    ["bafytestshardB00000000000000000000000000000000000000000001"]
  );
  await setupTx.wait();
  const [recordedOwner] = await custodyAsA.assets(fileHash1);
  console.log(`  fileHash: ${fileHash1}`);
  console.log(`  Custody-recorded owner: ${recordedOwner} (${recordedOwner === walletA.address ? "matches Wallet A ✓" : "MISMATCH ✗"})`);
  allPassed = allPassed && recordedOwner === walletA.address;

  // --- Test 1: front-running attempt (Wallet B tries to register Wallet A's fileHash) ---
  console.log("\n--- Test 1: Front-running attempt (should revert) ---");
  const t1 = await expectRevert(
    () => registryAsB.registerMerkleRoot(fileHash1, ethers.id("fake-root-by-B"), 1, ethers.ZeroAddress),
    "Wallet B registering Wallet A's fileHash",
    "Caller is not the Custody-recorded owner"
  );
  allPassed = allPassed && t1;

  // --- Test 2: legitimate owner succeeds ---
  console.log("\n--- Test 2: Legitimate owner (Wallet A) registers successfully ---");
  const realRoot = ethers.id("real-merkle-root-by-A");
  const t2 = await expectSuccess(
    () => registryAsA.registerMerkleRoot(fileHash1, realRoot, 4, ethers.ZeroAddress),
    "Wallet A registering their own fileHash"
  );
  allPassed = allPassed && t2;

  if (t2) {
    const proof = await registryAsA.getAssetProof(fileHash1);
    console.log(`  Stored owner: ${proof.owner} (${proof.owner === walletA.address ? "correct ✓" : "WRONG ✗"})`);
    console.log(`  Stored merkleRoot: ${proof.merkleRoot} (${proof.merkleRoot === realRoot ? "correct ✓" : "WRONG ✗"})`);
    allPassed = allPassed && proof.owner === walletA.address && proof.merkleRoot === realRoot;
  }

  // --- Test 3a: unregistered node is rejected ---
  console.log("\n--- Test 3a: Unregistered _node value (should revert) ---");
  const fileHash2 = randomFileHash("test2");
  const setupTx2 = await custodyAsA.batchRegisterAssets(
    [fileHash2],
    [6789],
    ["bafytestshardA00000000000000000000000000000000000000000002"],
    ["bafytestshardB00000000000000000000000000000000000000000002"]
  );
  await setupTx2.wait();
  const t3a = await expectRevert(
    () => registryAsA.registerMerkleRoot(fileHash2, ethers.id("root-2"), 1, walletB.address),
    "unregistered node attribution",
    "Node not registered"
  );
  allPassed = allPassed && t3a;

  // --- Test 3b: owner approves the node, then it works ---
  console.log("\n--- Test 3b: Owner approves Wallet B as a node, then registration with that node succeeds ---");
  const approveTx = await registryAsOwner.setNodeRegistered(walletB.address, true);
  await approveTx.wait();
  const isRegistered = await registryAsA.isRegisteredNode(walletB.address);
  console.log(`  isRegisteredNode(Wallet B): ${isRegistered}`);
  const t3b = await expectSuccess(
    () => registryAsA.registerMerkleRoot(fileHash2, ethers.id("root-2"), 1, walletB.address),
    "registration with an approved node"
  );
  allPassed = allPassed && isRegistered && t3b;

  // --- Test 3c: address(0) still works (documented "no node yet" case) ---
  console.log("\n--- Test 3c: address(0) for _node (documented no-node-yet case, should succeed) ---");
  const fileHash3 = randomFileHash("test3");
  const setupTx3 = await custodyAsA.batchRegisterAssets(
    [fileHash3],
    [111],
    ["bafytestshardA00000000000000000000000000000000000000000003"],
    ["bafytestshardB00000000000000000000000000000000000000000003"]
  );
  await setupTx3.wait();
  const t3c = await expectSuccess(
    () => registryAsA.registerMerkleRoot(fileHash3, ethers.id("root-3"), 1, ethers.ZeroAddress),
    "address(0) node"
  );
  allPassed = allPassed && t3c;

  // --- Test 4: double-registration still blocked (regression check on existing guard) ---
  console.log("\n--- Test 4: Re-registering an already-registered fileHash (should still revert) ---");
  const t4 = await expectRevert(
    () => registryAsA.registerMerkleRoot(fileHash1, ethers.id("second-attempt"), 1, ethers.ZeroAddress),
    "double registration",
    "Already registered"
  );
  allPassed = allPassed && t4;

  console.log(`\n${"=".repeat(60)}`);
  console.log(allPassed ? "✅ ALL VERIFICATION CHECKS PASSED" : "❌ ONE OR MORE CHECKS FAILED — see above");
  console.log("=".repeat(60));
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
