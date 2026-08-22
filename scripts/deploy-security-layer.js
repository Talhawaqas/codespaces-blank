import hre from "hardhat";

// Deploys the 4 Security Layer contracts (InayaThreatRegistry, InayaThreatReporter,
// InayaNodeReputation, InayaSecurityPolicy). Reuses the SAME relayer wallet already funded
// and used by the settlement relayer (RELAYER_PRIVATE_KEY, see
// inaya-network-dapp/src/app/api/nodes/settlements/release/route.js) rather than minting a
// second hot wallet to fund and manage.
//
// InayaThreatRegistry and InayaThreatReporter reference each other (registry.reporter must be
// the reporter contract's address; reporter.registry must be the registry's address) — a
// classic circular-constructor problem. Resolved the same way InayaProofRegistry could have
// been but wasn't needed to: deploy the registry first with a temporary placeholder reporter
// (the deployer's own address, which already passes the constructor's non-zero check), deploy
// the reporter with the real registry address, then call registry.setReporter() once to point
// it at the real reporter contract.

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  if (!process.env.RELAYER_PRIVATE_KEY) {
    throw new Error("RELAYER_PRIVATE_KEY is not set — the same relayer wallet used by the settlement relayer is required here.");
  }
  const relayerAddress = new hre.ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address;
  console.log("Relayer wallet (reused from settlements relayer):", relayerAddress);

  // 1. Registry, with a temporary placeholder reporter (the deployer) so the constructor's
  //    non-zero-address check passes -- corrected below once the real reporter exists.
  const Registry = await hre.ethers.getContractFactory("InayaThreatRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("InayaThreatRegistry deployed to:", registryAddress, "(placeholder reporter =", deployer.address, ")");

  // 2. Reporter, pointed at the real registry.
  const Reporter = await hre.ethers.getContractFactory("InayaThreatReporter");
  const reporter = await Reporter.deploy(registryAddress, relayerAddress);
  await reporter.waitForDeployment();
  const reporterAddress = await reporter.getAddress();
  console.log("InayaThreatReporter deployed to:", reporterAddress);

  // 3. Fix up the registry to point at the real reporter.
  const setReporterTx = await registry.setReporter(reporterAddress);
  await setReporterTx.wait();
  console.log("InayaThreatRegistry.reporter corrected to:", reporterAddress);

  // 4 & 5. Independent contracts, no circular dependency.
  const NodeReputation = await hre.ethers.getContractFactory("InayaNodeReputation");
  const nodeReputation = await NodeReputation.deploy(relayerAddress);
  await nodeReputation.waitForDeployment();
  const nodeReputationAddress = await nodeReputation.getAddress();
  console.log("InayaNodeReputation deployed to:", nodeReputationAddress);

  const SecurityPolicy = await hre.ethers.getContractFactory("InayaSecurityPolicy");
  const securityPolicy = await SecurityPolicy.deploy(relayerAddress);
  await securityPolicy.waitForDeployment();
  const securityPolicyAddress = await securityPolicy.getAddress();
  console.log("InayaSecurityPolicy deployed to:", securityPolicyAddress);

  console.log("\n=== Save these to your env (backend + client config) ===");
  console.log("NEXT_PUBLIC_THREAT_REGISTRY_ADDRESS =", registryAddress);
  console.log("NEXT_PUBLIC_THREAT_REPORTER_ADDRESS =", reporterAddress);
  console.log("NEXT_PUBLIC_NODE_REPUTATION_ADDRESS =", nodeReputationAddress);
  console.log("NEXT_PUBLIC_SECURITY_POLICY_ADDRESS =", securityPolicyAddress);
  console.log("===========================================================\n");

  console.log("Verify on BscScan:");
  console.log(`npx hardhat verify --network bscTestnet ${registryAddress} ${deployer.address}`);
  console.log(`npx hardhat verify --network bscTestnet ${reporterAddress} ${registryAddress} ${relayerAddress}`);
  console.log(`npx hardhat verify --network bscTestnet ${nodeReputationAddress} ${relayerAddress}`);
  console.log(`npx hardhat verify --network bscTestnet ${securityPolicyAddress} ${relayerAddress}`);
  console.log("\nNote: InayaThreatRegistry's constructor arg for verification is the ORIGINAL");
  console.log("placeholder reporter (the deployer address above), not the corrected one --");
  console.log("BscScan verifies against the actual deployed bytecode/constructor call.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
