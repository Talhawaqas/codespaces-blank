// test/ChainIdsSync.test.js
//
// Multi-chain SOW, Phase 1 — contracts/bridge/ChainIds.sol's own header
// comment admits it "must stay in sync with
// solana/programs/inaya-bridge-solana/src/constants.rs" (and, by the
// same logic, with inaya-network-dapp/src/lib/chains.js's CHAIN_IDS,
// which is this project's actual single source of truth for what chains
// exist per Phase 1). Three files, three languages, one set of numbers —
// a manual "remember to update all three" convention isn't a safeguard,
// it's a wish. This test parses all three via regex (no cross-language
// import possible) and fails loudly the moment one drifts from the
// others, the same drift-check pattern already applied to
// bridge-sdk/src/chains.js (see packages/bridge-sdk/test/chains-sync.test.mjs).
//
// Run with: npx hardhat test test/ChainIdsSync.test.js

import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

function parseSolConstants(filePath) {
  const src = fs.readFileSync(filePath, "utf-8");
  const out = {};
  // uint256 internal constant NAME = 123; (underscores allowed in the literal)
  for (const m of src.matchAll(/uint256\s+internal\s+constant\s+(\w+)\s*=\s*([\d_]+)\s*;/g)) {
    out[m[1]] = Number(m[2].replace(/_/g, ""));
  }
  return out;
}

function parseRustConstants(filePath) {
  const src = fs.readFileSync(filePath, "utf-8");
  const out = {};
  // pub const NAME: u64 = 123; (underscores allowed in the literal)
  for (const m of src.matchAll(/pub const (\w+):\s*u64\s*=\s*([\d_]+)\s*;/g)) {
    out[m[1]] = Number(m[2].replace(/_/g, ""));
  }
  return out;
}

async function loadJsChainIds() {
  const chainsPath = path.join(REPO_ROOT, "inaya-network-dapp", "src", "lib", "chains.js");
  const mod = await import(pathToFileURL(chainsPath).href);
  return { ...mod.CHAIN_IDS, SOLANA_DEVNET: mod.SOLANA_DEVNET_CHAIN_ID };
}

// Maps each side's own naming convention to one canonical key, so the
// comparison isn't defeated by BSC_TESTNET vs. BSC_TESTNET_CHAIN_ID vs.
// bscTestnet-style differences across three languages' conventions.
const SOL_TO_CANONICAL = { BSC_TESTNET: "BSC_TESTNET", ETH_SEPOLIA: "SEPOLIA", POLYGON_AMOY: "AMOY", AVALANCHE_FUJI: "FUJI", SOLANA_DEVNET: "SOLANA_DEVNET" };
const RUST_TO_CANONICAL = { BSC_TESTNET_CHAIN_ID: "BSC_TESTNET", ETH_SEPOLIA_CHAIN_ID: "SEPOLIA", POLYGON_AMOY_CHAIN_ID: "AMOY", AVALANCHE_FUJI_CHAIN_ID: "FUJI", SOLANA_DEVNET_CHAIN_ID: "SOLANA_DEVNET" };

describe("Chain ID sync across chains.js / ChainIds.sol / constants.rs", function () {
  let jsIds, solIds, rustIds;

  before(async function () {
    jsIds = await loadJsChainIds();
    const rawSol = parseSolConstants(path.join(REPO_ROOT, "contracts", "bridge", "ChainIds.sol"));
    solIds = Object.fromEntries(Object.entries(SOL_TO_CANONICAL).map(([solKey, canonical]) => [canonical, rawSol[solKey]]));
    const rawRust = parseRustConstants(path.join(REPO_ROOT, "solana", "programs", "inaya-bridge-solana", "src", "constants.rs"));
    rustIds = Object.fromEntries(Object.entries(RUST_TO_CANONICAL).map(([rustKey, canonical]) => [canonical, rawRust[rustKey]]));
  });

  for (const canonical of ["BSC_TESTNET", "SEPOLIA", "AMOY", "FUJI", "SOLANA_DEVNET"]) {
    it(`${canonical} matches across all three files`, function () {
      expect(solIds[canonical], `ChainIds.sol is missing/renamed ${canonical}`).to.not.be.undefined;
      expect(rustIds[canonical], `constants.rs is missing/renamed ${canonical}`).to.not.be.undefined;
      expect(jsIds[canonical], `chains.js is missing/renamed ${canonical}`).to.not.be.undefined;
      expect(solIds[canonical]).to.equal(jsIds[canonical], `ChainIds.sol's ${canonical} doesn't match chains.js`);
      expect(rustIds[canonical]).to.equal(jsIds[canonical], `constants.rs's ${canonical} doesn't match chains.js`);
    });
  }
});
