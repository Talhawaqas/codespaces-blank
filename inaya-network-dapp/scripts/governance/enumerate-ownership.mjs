#!/usr/bin/env node
// scripts/governance/enumerate-ownership.mjs
//
// Governance Charter Phase 0, step 1: "identify every Ownable contract's
// current owner." Read-only -- makes no transactions, changes nothing.
// Run with: node scripts/governance/enumerate-ownership.mjs
//
// Every address below was validated on-chain (not just copied from
// .env.local) when this script was written: all 9 contracts share the
// same single-EOA owner, and InayaNodeRegistry's narrower `verifierWallet`
// (not `owner`) is already a real 2-of-3 Gnosis Safe. See the printed
// SAFE CHECK section for why that distinction matters for Phase 0.

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";

function envVar(name) {
  const envText = fs.readFileSync(path.join(__dirname, "../../.env.local"), "utf8");
  const m = envText.match(new RegExp(`^${name}\\s*=\\s*(\\S+)`, "m"));
  return m ? m[1].trim() : null;
}

// Every contract in contracts/ that declares `is Ownable` (grep-verified,
// not guessed) with its address read from the same .env.local the app itself
// uses -- this script is the audit trail proving that mapping is accurate.
const OWNABLE_CONTRACTS = {
  InayaNodeRegistry: "NEXT_PUBLIC_NODE_REGISTRY_ADDRESS",
  InayaProofRegistry: "NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS",
  InayaCorporateEscrow: "NEXT_PUBLIC_CORPORATE_ESCROW_ADDRESS",
  InayaStaking: "NEXT_PUBLIC_STAKING_ADDRESS",
  InayaEgressTimelockVault: "NEXT_PUBLIC_EGRESS_VAULT_ADDRESS",
  InayaThreatRegistry: "NEXT_PUBLIC_THREAT_REGISTRY_ADDRESS",
  InayaThreatReporter: "NEXT_PUBLIC_THREAT_REPORTER_ADDRESS",
  InayaNodeReputation: "NEXT_PUBLIC_NODE_REPUTATION_ADDRESS",
  InayaSecurityPolicy: "NEXT_PUBLIC_SECURITY_POLICY_ADDRESS",
};

const OWNABLE_ABI = ["function owner() view returns (address)"];
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
];

// EIP-7702 (Pectra) lets a plain EOA carry a "delegation designator" --
// getCode() returns 0xef0100 + a 20-byte target address, but the account is
// still a single private key with full unilateral control; the delegate
// contract adds convenience (batching, sponsored gas), not multisig
// protection. Naively treating "has bytecode" as "is a multisig" is wrong
// and would badly understate how exposed a single-key owner actually is --
// classify this case explicitly instead of lumping it in with real
// multisig/Safe contracts.
const EIP7702_DELEGATION_PREFIX = "0xef0100";

function classifyCode(code) {
  if (code === "0x") return "eoa";
  if (code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)) return "eip7702-delegated-eoa";
  return "contract";
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const results = [];

  console.log("=== Inaya Governance Charter -- Phase 0: Ownership Audit ===");
  console.log(`RPC: ${RPC}\n`);

  for (const [name, envKey] of Object.entries(OWNABLE_CONTRACTS)) {
    const raw = envVar(envKey);
    if (!raw) {
      results.push({ name, address: null, owner: null, isMultisig: null, error: `${envKey} not set` });
      continue;
    }
    let address;
    try {
      address = ethers.getAddress(raw.toLowerCase());
    } catch (e) {
      results.push({ name, address: raw, owner: null, isMultisig: null, error: `invalid address: ${e.message}` });
      continue;
    }
    try {
      const contract = new ethers.Contract(address, OWNABLE_ABI, provider);
      const owner = await contract.owner();
      const ownerCode = await provider.getCode(owner);
      results.push({ name, address, owner, codeClass: classifyCode(ownerCode), error: null });
    } catch (e) {
      results.push({ name, address, owner: null, codeClass: null, error: e.shortMessage || e.message });
    }
  }

  const FLAG_LABEL = {
    eoa: "[SINGLE EOA]",
    "eip7702-delegated-eoa": "[SINGLE EOA -- EIP-7702 delegated, still one key]",
    contract: "[contract -- verify it's actually a multisig, not just any contract]",
  };

  const nameWidth = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(nameWidth)} ERROR: ${r.error}`);
      continue;
    }
    console.log(`${r.name.padEnd(nameWidth)} ${r.address}  owner=${r.owner}  ${FLAG_LABEL[r.codeClass]}`);
  }

  // "contract" alone isn't proof of multisig protection either -- it just means
  // it's not a single key OR an EIP-7702-delegated single key. Only "eoa" and
  // "eip7702-delegated-eoa" are unambiguously single-key-controlled; anything
  // classified "contract" still needs the same getOwners()/getThreshold() check
  // this script already runs against verifierWallet below before trusting it.
  const singleKeyResults = results.filter((r) => r.owner && (r.codeClass === "eoa" || r.codeClass === "eip7702-delegated-eoa"));
  const singleKeyOwners = new Set(singleKeyResults.map((r) => r.owner));
  console.log("\n--- Summary ---");
  if (singleKeyOwners.size === 0) {
    console.log("No contract above is owned by a plain single-key EOA. Confirm each 'contract'");
    console.log("owner really is a real multisig (getOwners/getThreshold) before calling Phase 0 done.");
  } else {
    console.log(`${singleKeyResults.length} of ${results.length} contracts are owned by a single key:`);
    for (const eoa of singleKeyOwners) console.log(`  - ${eoa}`);
    console.log("\nThis is exactly what Phase 0 of the governance charter targets. See");
    console.log("scripts/governance/transfer-ownership-to-safe.mjs for the (dry-run by");
    console.log("default) migration script.");
  }

  // Separately: check the NodeRegistry's verifierWallet, since it's a narrower
  // permission than owner() and easy to mistake for "governance is already handled."
  const nodeRegistryAddr = envVar("NEXT_PUBLIC_NODE_REGISTRY_ADDRESS");
  if (nodeRegistryAddr) {
    console.log("\n--- Separately: InayaNodeRegistry.verifierWallet() ---");
    const registry = new ethers.Contract(
      ethers.getAddress(nodeRegistryAddr.toLowerCase()),
      ["function verifierWallet() view returns (address)"],
      provider
    );
    const verifier = await registry.verifierWallet();
    const verifierCode = await provider.getCode(verifier);
    const verifierClass = classifyCode(verifierCode);
    console.log(`verifierWallet = ${verifier} (${verifierClass})`);
    if (verifierClass === "contract") {
      try {
        const safe = new ethers.Contract(verifier, SAFE_ABI, provider);
        const owners = await safe.getOwners();
        const threshold = await safe.getThreshold();
        const version = await safe.VERSION().catch(() => "unknown");
        console.log(`This IS a real Gnosis Safe v${version}: ${threshold}-of-${owners.length}`);
        console.log(`Signers: ${owners.join(", ")}`);
        console.log("\nIMPORTANT: this Safe only gates verifierWallet (settlement queue/release");
        console.log("authority) on InayaNodeRegistry -- it is NOT the owner() of any contract");
        console.log("listed above. Reusing it as the Article IX Security Council multisig is a");
        console.log("real option (it already exists, is already trusted for a security-critical");
        console.log("role, and its signers are already known people) but it is currently");
        console.log(`${threshold}-of-${owners.length}, while the charter's draft spec calls for 3-of-5.`);
        console.log("That gap is a decision for the founding team, not something this script");
        console.log("should resolve on its own.");
      } catch (e) {
        console.log(`Not a standard Gnosis Safe interface: ${e.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
