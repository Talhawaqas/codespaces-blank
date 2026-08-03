import hre from "hardhat";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // Sirf Proof Registry deploy kar rahe hain
  const ProofRegistry = await hre.ethers.getContractFactory("InayaProofRegistry");
  const proofRegistry = await ProofRegistry.deploy();
  await proofRegistry.waitForDeployment();
  const proofRegistryAddress = await proofRegistry.getAddress();
  
  console.log("✅ InayaProofRegistry deployed to:", proofRegistryAddress);

  // --- DUMMY TEST REGISTRATION (Verifier script test karne ke liye) ---
  console.log("📝 Registering dummy test Merkle root on-chain...");
  const dummyFileHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const dummyMerkleRoot = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const dummyChunkCount = 1;

  const tx = await proofRegistry.registerMerkleRoot(
    dummyFileHash,
    dummyMerkleRoot,
    dummyChunkCount,
    deployer.address
  );
  await tx.wait();
  console.log("✅ Dummy Merkle root successfully registered on-chain!");
  // -------------------------------------------------------------------

  console.log("\n=== Is address ko apne frontend/backend mein save kar lo ===");
  console.log("NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS =", proofRegistryAddress);
  console.log("===============================================================\n");

  console.log("BscScan par verify karne ke liye ye command chalana:");
  console.log(`npx hardhat verify --network bscTestnet ${proofRegistryAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});