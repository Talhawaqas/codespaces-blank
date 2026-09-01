#!/usr/bin/env node
// scripts/testnet-health-check.js
//
// Phase 6 (Testing & Testnet Deployment) — read-only connectivity +
// bytecode/account-existence check across every chain this project has
// bridge contracts on: BSC Testnet (home), Ethereum Sepolia, Avalanche
// Fuji, and Solana Devnet (Polygon Amoy has no deployment file — no
// contracts deployed there yet, confirmed paused for insufficient test
// funds per CROSS_CHAIN_BRIDGE_GUIDE.md §6).
//
// Deliberately does nothing but read: no transactions, no state changes,
// no private keys touched. For each EVM chain it calls eth_getCode on
// every address in that chain's deployments/bridge/*.json and reports
// whether real bytecode is present (an empty "0x" means either nothing
// was ever deployed there or the RPC/address is wrong — this script
// can't tell those apart, it just reports the observed fact). For Solana
// it calls getAccountInfo on the program ID.
//
// Solana Devnet is checked via plain JSON-RPC fetch calls (getVersion,
// getAccountInfo) rather than @solana/web3.js — that package only lives
// in inaya-network-dapp/node_modules, not this repo root's, and pulling
// it in just for two read-only RPC calls isn't worth a cross-package
// import; the raw JSON-RPC shape is simple and stable.
//
// Run with (from the repo root, so ethers resolves from its
// node_modules and --env-file picks up inaya-network-dapp/.env.local):
//   node --env-file=inaya-network-dapp/.env.local scripts/testnet-health-check.js

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const EVM_CHAINS = [
  { label: "BSC Testnet (home)", file: "bscTestnet.json", rpcEnv: "BSC_TESTNET_RPC", fallbackRpc: "https://data-seed-prebsc-1-s1.binance.org:8545", chainId: 97 },
  { label: "Ethereum Sepolia (spoke)", file: "sepolia.json", rpcEnv: "SEPOLIA_RPC", fallbackRpc: "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111 },
  { label: "Avalanche Fuji (spoke)", file: "avalancheFuji.json", rpcEnv: "AVALANCHE_FUJI_RPC", fallbackRpc: "https://api.avax-test.network/ext/bc/C/rpc", chainId: 43113 },
  { label: "Arbitrum Sepolia (spoke)", file: "arbitrumSepolia.json", rpcEnv: "ARBITRUM_SEPOLIA_RPC", fallbackRpc: "https://sepolia-rollup.arbitrum.io/rpc", chainId: 421614 },
];

const ADDRESS_FIELDS = ["inayaToken", "wrappedToken", "chainRegistry", "validatorSet", "messenger", "bridge", "staking", "stakingGateway"];

async function checkEvmChain({ label, file, rpcEnv, fallbackRpc, chainId }) {
  console.log(`\n=== ${label} (chainId ${chainId}) ===`);
  const deploymentPath = path.join(REPO_ROOT, "deployments", "bridge", file);
  if (!fs.existsSync(deploymentPath)) {
    console.log(`  No deployment file at ${deploymentPath} — nothing deployed here yet.`);
    return;
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const rpcUrl = process.env[rpcEnv] || fallbackRpc;

  let provider, network;
  try {
    provider = new ethers.JsonRpcProvider(rpcUrl);
    network = await provider.getNetwork();
  } catch (err) {
    console.log(`  RPC UNREACHABLE (${rpcUrl}): ${err.message}`);
    return;
  }
  const chainIdMatch = Number(network.chainId) === chainId;
  console.log(`  RPC reachable: ${rpcUrl} (reports chainId ${network.chainId}${chainIdMatch ? "" : `, EXPECTED ${chainId} — MISMATCH`})`);

  let blockNumber;
  try {
    blockNumber = await provider.getBlockNumber();
    console.log(`  Current block: ${blockNumber}`);
  } catch (err) {
    console.log(`  getBlockNumber failed: ${err.message}`);
  }

  for (const field of ADDRESS_FIELDS) {
    const address = deployment[field];
    if (!address) continue;
    try {
      const code = await provider.getCode(address);
      const hasCode = code && code !== "0x";
      console.log(`  ${field.padEnd(16)} ${address}  ${hasCode ? `deployed (${(code.length - 2) / 2} bytes)` : "NO CODE FOUND"}`);
    } catch (err) {
      console.log(`  ${field.padEnd(16)} ${address}  ERROR: ${err.message}`);
    }
  }
}

async function solanaRpc(cluster, method, params) {
  const res = await fetch(cluster, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function checkSolanaDevnet() {
  console.log(`\n=== Solana Devnet (spoke) ===`);
  const deploymentPath = path.join(REPO_ROOT, "deployments", "bridge", "solanaDevnet.json");
  if (!fs.existsSync(deploymentPath)) {
    console.log(`  No deployment file — nothing deployed here yet.`);
    return;
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  try {
    const version = await solanaRpc(deployment.cluster, "getVersion", []);
    console.log(`  RPC reachable: ${deployment.cluster} (solana-core ${version["solana-core"]})`);
  } catch (err) {
    console.log(`  RPC UNREACHABLE (${deployment.cluster}): ${err.message}`);
    return;
  }

  try {
    const info = await solanaRpc(deployment.cluster, "getAccountInfo", [deployment.programId, { encoding: "base64" }]);
    if (!info || !info.value) {
      console.log(`  programId ${deployment.programId}  NO ACCOUNT FOUND`);
    } else {
      const dataLen = info.value.data?.[0] ? Buffer.from(info.value.data[0], "base64").length : 0;
      console.log(`  programId ${deployment.programId}  account exists (${dataLen} bytes, executable=${info.value.executable})`);
    }
  } catch (err) {
    console.log(`  programId lookup ERROR: ${err.message}`);
  }
  if (deployment.notes) console.log(`  Note from deployment file: ${deployment.notes}`);
}

async function main() {
  console.log("Inaya multi-chain testnet health check — read-only, no transactions.");
  for (const chain of EVM_CHAINS) {
    await checkEvmChain(chain);
  }
  await checkSolanaDevnet();

  console.log(`\n=== Polygon Amoy ===`);
  console.log(`  No deployments/bridge/amoy.json — confirmed not yet deployed (paused for insufficient test funds per CROSS_CHAIN_BRIDGE_GUIDE.md §6). Nothing to check.`);
}

main().catch((err) => {
  console.error("Health check crashed:", err);
  process.exit(1);
});
