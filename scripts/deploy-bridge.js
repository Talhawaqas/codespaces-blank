// scripts/deploy-bridge.js
//
// Deploys the cross-chain bridge + cross-chain staking contract set for WHICHEVER network is
// currently selected (`--network <name>`). Home (bscTestnet / localHome) gets the lock-side +
// canonical staking ledger; every other configured network gets the mint/burn spoke side.
//
// Run once per network, e.g.:
//   npx hardhat run scripts/deploy-bridge.js --network localHome
//   npx hardhat run scripts/deploy-bridge.js --network localSepolia
//   npx hardhat run scripts/deploy-bridge.js --network localAmoy
//   npx hardhat run scripts/deploy-bridge.js --network localFuji
// then, once every network above has a deployment file:
//   npx hardhat run scripts/wire-bridge-registries.js --network localHome
//   npx hardhat run scripts/wire-bridge-registries.js --network localSepolia
//   ...(once per network)
//
// Writes deployments/bridge/<network>.json with every deployed address, consumed by
// scripts/wire-bridge-registries.js.

import hre from "hardhat";
import fs from "fs";
import path from "path";

const { ethers, network } = hre;

const HOME_NETWORKS = new Set(["bscTestnet", "localHome"]);
const FAMILY_EVM = 0;

const DEPLOYMENTS_DIR = path.join(process.cwd(), "deployments", "bridge");

function saveDeployment(data) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = path.join(DEPLOYMENTS_DIR, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\nWrote ${file}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isHome = HOME_NETWORKS.has(network.name);

  console.log(`Deploying bridge contracts on "${network.name}" (chainId ${chainId}) as ${isHome ? "HOME" : "SPOKE"}`);
  console.log(`Deployer: ${deployer.address}`);

  // Validator committee: for now, all signers come from the same DEPLOYER_PRIVATE_KEY-derived
  // account list used elsewhere in this repo, matching RELAYER_PRIVATE_KEY's existing
  // single-operator precedent for the testnet phase. Real independent validator keys should
  // replace VALIDATOR_ADDRESS_1/2/3 before any mainnet consideration.
  const validators = [
    process.env.VALIDATOR_ADDRESS_1,
    process.env.VALIDATOR_ADDRESS_2,
    process.env.VALIDATOR_ADDRESS_3
  ].filter(Boolean);
  if (validators.length < 2) {
    throw new Error("Set at least VALIDATOR_ADDRESS_1 and VALIDATOR_ADDRESS_2 in .env before deploying.");
  }
  const threshold = Math.min(2, validators.length);

  const Registry = await ethers.getContractFactory("InayaChainRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  console.log(`InayaChainRegistry: ${await registry.getAddress()}`);

  const ValidatorSet = await ethers.getContractFactory("InayaValidatorSet");
  const validatorSet = await ValidatorSet.deploy(deployer.address, validators, threshold);
  await validatorSet.waitForDeployment();
  console.log(`InayaValidatorSet: ${await validatorSet.getAddress()} (${validators.length} validators, threshold ${threshold})`);

  const Messenger = await ethers.getContractFactory("InayaMessenger");
  const messenger = await Messenger.deploy(deployer.address, await registry.getAddress(), await validatorSet.getAddress());
  await messenger.waitForDeployment();
  console.log(`InayaMessenger: ${await messenger.getAddress()}`);

  if (isHome) {
    let inayaTokenAddress = process.env.NEXT_PUBLIC_INAYA_TOKEN_ADDRESS;
    if (network.name.startsWith("local")) {
      // Local simulation can't reach the real BSC-testnet-deployed $INAYA -- deploy a fresh
      // instance with identical fee/cap behavior instead (contracts/InayaToken.sol, the same
      // test-only copy the Hardhat test suite uses).
      const InayaToken = await ethers.getContractFactory("InayaToken");
      const inaya = await InayaToken.deploy();
      await inaya.waitForDeployment();
      inayaTokenAddress = await inaya.getAddress();
      console.log(`(local) Deployed a fresh InayaToken for simulation: ${inayaTokenAddress}`);
    }
    if (!inayaTokenAddress) throw new Error("Set NEXT_PUBLIC_INAYA_TOKEN_ADDRESS in .env before deploying home.");

    const BridgeHome = await ethers.getContractFactory("InayaTokenBridgeHome");
    const bridge = await BridgeHome.deploy(deployer.address, inayaTokenAddress, await messenger.getAddress());
    await bridge.waitForDeployment();
    console.log(`InayaTokenBridgeHome: ${await bridge.getAddress()}`);

    const Staking = await ethers.getContractFactory("InayaStaking");
    const staking = await Staking.deploy(inayaTokenAddress, inayaTokenAddress);
    await staking.waitForDeployment();
    console.log(`InayaStaking (v2, cross-chain-capable): ${await staking.getAddress()}`);

    const StakingGatewayHome = await ethers.getContractFactory("InayaStakingGatewayHome");
    const stakingGateway = await StakingGatewayHome.deploy(
      deployer.address,
      await staking.getAddress(),
      await bridge.getAddress(),
      await messenger.getAddress()
    );
    await stakingGateway.waitForDeployment();
    console.log(`InayaStakingGatewayHome: ${await stakingGateway.getAddress()}`);

    // Same-chain fix-ups that don't need any other chain's address yet.
    await staking.setCrossChainGateway(await stakingGateway.getAddress());
    await bridge.setAuthorizedModule(await stakingGateway.getAddress(), true);
    await messenger.setAuthorizedSender(await bridge.getAddress(), true);
    await messenger.setHandler(1 /* TOKEN_BURN_NOTICE */, await bridge.getAddress());
    await messenger.setHandler(2 /* STAKE_REQUEST */, await stakingGateway.getAddress());

    saveDeployment({
      role: "home",
      network: network.name,
      chainId,
      inayaToken: inayaTokenAddress,
      chainRegistry: await registry.getAddress(),
      validatorSet: await validatorSet.getAddress(),
      messenger: await messenger.getAddress(),
      bridge: await bridge.getAddress(),
      staking: await staking.getAddress(),
      stakingGateway: await stakingGateway.getAddress()
    });
  } else {
    // Spoke deploys need home's chainId + bridge/staking-gateway addresses -- read from the
    // already-produced home deployment file (deploy home first).
    const homeFile = path.join(DEPLOYMENTS_DIR, network.name.startsWith("local") ? "localHome.json" : "bscTestnet.json");
    if (!fs.existsSync(homeFile)) {
      throw new Error(`Home deployment file not found at ${homeFile} -- deploy home first.`);
    }
    const home = JSON.parse(fs.readFileSync(homeFile, "utf8"));

    const Wrapped = await ethers.getContractFactory("InayaWrappedINAYA");
    const wrapped = await Wrapped.deploy(deployer.address, deployer.address); // placeholder bridge, fixed up below
    await wrapped.waitForDeployment();
    console.log(`InayaWrappedINAYA: ${await wrapped.getAddress()}`);

    const BridgeSpoke = await ethers.getContractFactory("InayaTokenBridgeSpoke");
    const bridge = await BridgeSpoke.deploy(
      deployer.address,
      await wrapped.getAddress(),
      await messenger.getAddress(),
      home.chainId,
      ethers.zeroPadValue(home.bridge, 32)
    );
    await bridge.waitForDeployment();
    await wrapped.setBridge(await bridge.getAddress());
    console.log(`InayaTokenBridgeSpoke: ${await bridge.getAddress()}`);

    const StakingGatewaySpoke = await ethers.getContractFactory("InayaStakingGatewaySpoke");
    const stakingGateway = await StakingGatewaySpoke.deploy(
      deployer.address,
      await bridge.getAddress(),
      await messenger.getAddress(),
      home.chainId,
      ethers.zeroPadValue(home.stakingGateway, 32)
    );
    await stakingGateway.waitForDeployment();
    console.log(`InayaStakingGatewaySpoke: ${await stakingGateway.getAddress()}`);

    await bridge.setAuthorizedInitiator(await stakingGateway.getAddress(), true);
    await messenger.setAuthorizedSender(await bridge.getAddress(), true);
    await messenger.setAuthorizedSender(await stakingGateway.getAddress(), true);
    await messenger.setHandler(0 /* TOKEN_MINT */, await bridge.getAddress());

    saveDeployment({
      role: "spoke",
      network: network.name,
      chainId,
      homeChainId: home.chainId,
      wrappedToken: await wrapped.getAddress(),
      chainRegistry: await registry.getAddress(),
      validatorSet: await validatorSet.getAddress(),
      messenger: await messenger.getAddress(),
      bridge: await bridge.getAddress(),
      stakingGateway: await stakingGateway.getAddress()
    });
  }

  console.log("\nDone. Next: run scripts/wire-bridge-registries.js against EVERY network once all deployments exist.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
