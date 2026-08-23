#!/usr/bin/env node
// scripts/governance/transfer-ownership-to-safe.mjs
//
// Governance Charter Phase 0, step 2: the actual transferOwnership() call
// sequence for every Ownable contract, targeting the Security Council Safe.
//
// SAFE BY DEFAULT: this script only PRINTS what it would do. It never sends
// a transaction unless you pass --execute AND set DEPLOYER_PRIVATE_KEY, and
// even then it asks for one more confirmation. Run it plain first:
//
//   node scripts/governance/transfer-ownership-to-safe.mjs --safe=0x27413C3930B228588d0C39d090bae6Ee7030560D
//
// --safe is REQUIRED and has no default -- see enumerate-ownership.mjs's
// printed findings before picking a value. Two real options exist today:
//   1. Reuse 0x27413C3930B228588d0C39d090bae6Ee7030560D, the already-deployed
//      2-of-3 Gnosis Safe currently gating InayaNodeRegistry.verifierWallet.
//      Fastest path, but it's 2-of-3 where the governance charter's draft
//      spec calls for 3-of-5, and its 3 signers were chosen for a narrower
//      "settlement verifier" role, not full contract ownership.
//   2. Deploy a fresh 3-of-5 Safe (via https://app.safe.global or the Safe
//      SDK) with a deliberately-chosen 5-signer set for this broader
//      responsibility, and target THAT address instead.
// This script does not pick for you.
//
// Irreversibility note: transferOwnership() on every contract here hands
// FULL owner-only control (fee changes, pausing, relayer/verifier rotation,
// fund recovery on some contracts) to whatever address you pass. If that
// address is a Safe, losing enough signer keys to fall below its threshold
// permanently locks these contracts' admin functions. There is no "undo"
// short of the new owner calling transferOwnership() back.

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";

function envVar(name) {
  const envText = fs.readFileSync(path.join(__dirname, "../../.env.local"), "utf8");
  const m = envText.match(new RegExp(`^${name}\\s*=\\s*(\\S+)`, "m"));
  return m ? m[1].trim() : null;
}

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

const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner) external",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const safeArg = args.find((a) => a.startsWith("--safe="));
  const safe = safeArg ? safeArg.split("=")[1] : null;
  return { execute, safe };
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const { execute, safe: rawSafe } = parseArgs();

  if (!rawSafe) {
    console.error("Missing required --safe=0x... argument. Run enumerate-ownership.mjs first");
    console.error("and read its SAFE CHECK section before picking a target address.");
    process.exitCode = 1;
    return;
  }
  const safeAddress = ethers.getAddress(rawSafe.toLowerCase());

  const provider = new ethers.JsonRpcProvider(RPC);
  const safeCode = await provider.getCode(safeAddress);
  if (safeCode === "0x") {
    console.error(`WARNING: ${safeAddress} has no contract code -- it looks like a plain EOA, not a`);
    console.error("Safe/multisig. Refusing to build a transferOwnership sequence to a single key.");
    process.exitCode = 1;
    return;
  }

  console.log(`=== Ownership migration plan: 9 contracts -> ${safeAddress} ===\n`);

  const plan = [];
  for (const [name, envKey] of Object.entries(OWNABLE_CONTRACTS)) {
    const raw = envVar(envKey);
    if (!raw) {
      console.log(`${name}: SKIPPED -- ${envKey} not set`);
      continue;
    }
    const address = ethers.getAddress(raw.toLowerCase());
    const contract = new ethers.Contract(address, OWNABLE_ABI, provider);
    const currentOwner = await contract.owner();
    if (currentOwner.toLowerCase() === safeAddress.toLowerCase()) {
      console.log(`${name} (${address}): already owned by the target Safe -- nothing to do.`);
      continue;
    }
    plan.push({ name, address, currentOwner, calldata: contract.interface.encodeFunctionData("transferOwnership", [safeAddress]) });
  }

  if (plan.length === 0) {
    console.log("\nNothing to migrate -- every contract already points at the target Safe.");
    return;
  }

  console.log(`\n${plan.length} transferOwnership() call(s) needed:\n`);
  for (const step of plan) {
    console.log(`  ${step.name}`);
    console.log(`    to:       ${step.address}`);
    console.log(`    from:     ${step.currentOwner}`);
    console.log(`    calldata: ${step.calldata}`);
    console.log(`    cast call equivalent:`);
    console.log(`      cast send ${step.address} "transferOwnership(address)" ${safeAddress} --private-key $DEPLOYER_PRIVATE_KEY --rpc-url ${RPC}`);
    console.log("");
  }

  console.log("IMPORTANT: transferOwnership() takes effect IMMEDIATELY, in one transaction --");
  console.log("these contracts do NOT use OpenZeppelin's Ownable2Step, so there is no");
  console.log("accept-ownership confirmation step from the Safe side. Triple-check the Safe");
  console.log("address above before executing anything.");

  if (!execute) {
    console.log("\n(Dry run -- no transactions sent. Re-run with --execute to actually send these,");
    console.log("requires DEPLOYER_PRIVATE_KEY to be set to the CURRENT owner's key.)");
    return;
  }

  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    console.error("\n--execute was passed but DEPLOYER_PRIVATE_KEY is not set. Aborting.");
    process.exitCode = 1;
    return;
  }

  const answer = await confirm(
    `\nType the Safe address (${safeAddress}) EXACTLY to confirm you want to send ${plan.length} real transferOwnership() transaction(s): `
  );
  if (answer.trim() !== safeAddress) {
    console.log("Confirmation did not match -- aborting, nothing sent.");
    return;
  }

  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  for (const step of plan) {
    console.log(`\nSending transferOwnership for ${step.name}...`);
    const tx = await wallet.sendTransaction({ to: step.address, data: step.calldata });
    console.log(`  tx: ${tx.hash} -- waiting for confirmation...`);
    await tx.wait();
    console.log(`  confirmed. ${step.name} is now owned by ${safeAddress}.`);
  }
  console.log("\nDone. Re-run enumerate-ownership.mjs to confirm the new state.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
