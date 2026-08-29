// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// Canonical chain-id registry for the Inaya cross-chain bridge.
//
// Real EVM chains use their real chainId. Non-EVM chains (which have no
// EVM-style numeric chainId) are assigned a sentinel in the reserved range
// >= 1_000_000_000 -- chosen because it can never collide with a real EVM
// chainId in any foreseeable future (the largest EVM chainIds in use today
// are in the low billions at most, and this project only ever targets a
// short, explicit allowlist of chains via InayaChainRegistry, so even a
// distant future collision would simply be caught at registration time).
//
// This file must stay in sync with `solana/programs/inaya-bridge-solana/src/constants.rs`
// on the Solana side -- both sides hardcode the same numeric values.
// ============================================================
library ChainIds {
    uint256 internal constant BSC_TESTNET = 97;
    uint256 internal constant BSC_MAINNET = 56;
    uint256 internal constant ETH_SEPOLIA = 11155111;
    uint256 internal constant POLYGON_AMOY = 80002;
    uint256 internal constant AVALANCHE_FUJI = 43113;

    // Reserved range for non-EVM chain families.
    uint256 internal constant SOLANA_MAINNET = 1_000_000_001;
    uint256 internal constant SOLANA_DEVNET = 1_000_000_002;

    // Informational "chain family" tag stored in InayaChainRegistry. Never
    // branched on inside the messenger/bridge logic itself -- purely for
    // off-chain tooling/UI to know how to talk to a given chain.
    uint8 internal constant FAMILY_EVM = 0;
    uint8 internal constant FAMILY_SOLANA = 1;
}
