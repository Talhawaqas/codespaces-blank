import hre from "hardhat";

// Deploys InayaOracleRegistry, InayaOracleAdapter, and InayaAutomationRegistry
// to BSC Testnet, then registers the two real demo entries this system ships
// with:
//   - Oracle source "inaya-usdt-price": the live PancakeSwap testnet
//     INAYA/USDT pool's spot price (same pool + getReserves() math already
//     used in inaya-network-dapp/src/app/api/create-egress-checkout-session/
//     route.js's getLiveInayaPriceUsdt() -- real data, not simulated).
//   - Automation task "release-node-settlements": InayaNodeRegistry's own
//     already-permissionless, already-time-locked releaseSettlementsBatch()
//     -- a genuine existing function nobody is currently calling
//     automatically, not a toy example.
//
// The deployer's own address is registered as both the oracle submitter and
// the automation worker for this pass -- same wallet already used for every
// other testnet deploy this session (DEPLOYER_PRIVATE_KEY). Its on-chain
// authority stays narrow regardless: it can only submit to the one source
// it's registered for (checked on-chain by the Registry), and it can only
// call already-permissionless functions elsewhere -- registering it here
// grants it nothing it didn't already have the right to do.

const NODE_REGISTRY_ADDRESS = "0xd12a38e8564d19797B19cF8F80b54DB09B3FD881";
const ORACLE_UPDATE_FREQUENCY_SECONDS = 5 * 60; // 5 minutes -- demo cadence, retune via updateSubmitter's sibling setters later

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // 1. Oracle Registry
  const Registry = await hre.ethers.getContractFactory("InayaOracleRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("InayaOracleRegistry deployed to:", registryAddress);

  // 2. Oracle Adapter, wired to the Registry
  const Adapter = await hre.ethers.getContractFactory("InayaOracleAdapter");
  const adapter = await Adapter.deploy(registryAddress);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log("InayaOracleAdapter deployed to:", adapterAddress);

  // 3. Register the real demo oracle source
  const priceSourceId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("inaya-usdt-price"));
  await (await registry.registerSource(priceSourceId, "INAYA/USDT price", deployer.address, ORACLE_UPDATE_FREQUENCY_SECONDS)).wait();
  console.log("Registered oracle source 'inaya-usdt-price', id:", priceSourceId);

  // 4. Automation Registry, worker = deployer for this pass
  const AutomationRegistry = await hre.ethers.getContractFactory("InayaAutomationRegistry");
  const automationRegistry = await AutomationRegistry.deploy(deployer.address);
  await automationRegistry.waitForDeployment();
  const automationRegistryAddress = await automationRegistry.getAddress();
  console.log("InayaAutomationRegistry deployed to:", automationRegistryAddress);

  // 5. Register the real demo automation task
  const releaseTaskId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("release-node-settlements"));
  const releaseSelector = hre.ethers.id("releaseSettlementsBatch(uint256[])").slice(0, 10);
  await (await automationRegistry.registerTask(
    releaseTaskId,
    NODE_REGISTRY_ADDRESS,
    releaseSelector,
    "Any queued InayaNodeRegistry settlement whose unlockTime has passed"
  )).wait();
  console.log("Registered automation task 'release-node-settlements', id:", releaseTaskId);

  console.log("\n=== Save these to your env (backend + client config) ===");
  console.log("NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS =", registryAddress);
  console.log("NEXT_PUBLIC_ORACLE_ADAPTER_ADDRESS =", adapterAddress);
  console.log("NEXT_PUBLIC_AUTOMATION_REGISTRY_ADDRESS =", automationRegistryAddress);
  console.log("===========================================================\n");

  console.log("Verify on BscScan:");
  console.log(`npx hardhat verify --network bscTestnet ${registryAddress}`);
  console.log(`npx hardhat verify --network bscTestnet ${adapterAddress} ${registryAddress}`);
  console.log(`npx hardhat verify --network bscTestnet ${automationRegistryAddress} ${deployer.address}`);

  console.log("\nRun the worker with: node scripts/automation-worker.mjs");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
