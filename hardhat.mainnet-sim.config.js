// hardhat.mainnet-sim.config.js
//
// Test-only sibling of hardhat.config.js, used ONLY to exercise
// InayaHackathonRewards.activateMainnet()'s success path (block.chainid == 56).
// Hardhat's in-process network can't change its chain id at runtime --
// hardhat_reset only supports overriding `forking`, not chainId -- so the
// only way to prove the guard's happy path for real is to boot a second
// in-process network that reports chain id 56 from the start.
//
// Run with:
//   npx hardhat test test/HackathonRewards.mainnetActivation.test.js --config hardhat.mainnet-sim.config.js
//
// This file is NOT used by the default `npx hardhat test` command and
// changes nothing about the real bscTestnet network, deploy scripts, or any
// other test in the suite.

import baseConfig from "./hardhat.config.js";

export default {
  ...baseConfig,
  networks: {
    ...baseConfig.networks,
    hardhat: { chainId: 56 }
  }
};
