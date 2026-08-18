// scripts/deploy-verifier-safe.cjs
//
// Deploys a 2-of-3 Safe (Gnosis Safe) on BSC Testnet to become the new verifierWallet for
// InayaNodeRegistry -- app.safe.global's hosted UI doesn't list BSC Testnet (no official
// Transaction Service backend for it), so this deploys directly against Safe's own verified
// contract addresses for chain 97 (from @safe-global/safe-deployments) using the same deployer
// key already used for every other on-chain deployment this session. Nothing new touches chat.
//
// Owners: deployer (owner), treasury, current verifier EOA. Threshold 2-of-3.
// After this succeeds, a SEPARATE explicit step calls setVerifierWallet() on the registry --
// not done automatically here, so the address can be sanity-checked first.

const Safe = require("@safe-global/protocol-kit").default;
const { ethers } = require("ethers");
require("dotenv").config();

const OWNERS = [
  "0x4BA0a7c39154e7B7fA72288D29D7fdaf0248b1F2", // deployer / registry owner
  "0x9DBb5F70a8bfA3Da470ed6Ac7F6322A5101a5B38", // treasury
  "0x618f429bF27Ef458B60c1211b9ca8b3CD5d9C175", // current verifier EOA
];
const THRESHOLD = 2;

async function main() {
  for (const addr of OWNERS) {
    if (ethers.getAddress(addr) !== addr) throw new Error(`Bad checksum: ${addr}`);
  }

  const rpcUrl = process.env.BSC_TESTNET_RPC;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployerWallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deploying from:", deployerWallet.address);
  console.log("Owners:", OWNERS);
  console.log("Threshold:", THRESHOLD, "of", OWNERS.length);

  const protocolKit = await Safe.init({
    provider: rpcUrl,
    signer: process.env.DEPLOYER_PRIVATE_KEY,
    predictedSafe: {
      safeAccountConfig: {
        owners: OWNERS,
        threshold: THRESHOLD,
      },
    },
  });

  const predictedAddress = await protocolKit.getAddress();
  console.log("Predicted Safe address:", predictedAddress);

  const deploymentTransaction = await protocolKit.createSafeDeploymentTransaction();

  const txResponse = await deployerWallet.sendTransaction({
    to: deploymentTransaction.to,
    value: BigInt(deploymentTransaction.value || 0),
    data: deploymentTransaction.data,
  });
  console.log("Deployment tx:", txResponse.hash);
  const receipt = await txResponse.wait();
  console.log("Confirmed in block:", receipt.blockNumber);

  const deployedProtocolKit = await protocolKit.connect({ safeAddress: predictedAddress });
  const isDeployed = await deployedProtocolKit.isSafeDeployed();
  const owners = await deployedProtocolKit.getOwners();
  const threshold = await deployedProtocolKit.getThreshold();

  console.log("\n=== Result ===");
  console.log("Safe deployed:", isDeployed);
  console.log("Safe address:", predictedAddress);
  console.log("Owners on-chain:", owners);
  console.log("Threshold on-chain:", threshold);
  console.log("BscScan:", `https://testnet.bscscan.com/address/${predictedAddress}`);

  if (!isDeployed) throw new Error("Safe reports not deployed after confirmed tx");
  if (threshold !== THRESHOLD) throw new Error(`Threshold mismatch: got ${threshold}`);
  const ownersMatch = OWNERS.every((o) => owners.map((x) => x.toLowerCase()).includes(o.toLowerCase())) && owners.length === OWNERS.length;
  if (!ownersMatch) throw new Error("Owners mismatch");
  console.log("\n✅ Safe verified on-chain: correct owners, correct threshold.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
