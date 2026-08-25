// scripts/automation-worker.mjs
//
// Run with: node scripts/automation-worker.mjs
//
// A standalone script -- NOT a hosted service this runs continuously as.
// You run it manually or wire it into your own scheduler (cron / Windows
// Task Scheduler). Same operator-controlled-key discipline as every deploy
// script in this repo: reads DEPLOYER_PRIVATE_KEY/BSC_TESTNET_RPC from the
// root .env, no new key management invented.
//
// One pass does exactly what the SOW's Demo 1/2/3/4 describe:
//   1. Reads the REAL live INAYA/USDT spot price from the PancakeSwap
//      testnet pool (same pool + getReserves() math already proven in
//      inaya-network-dapp/src/app/api/create-egress-checkout-session/
//      route.js's getLiveInayaPriceUsdt() -- computed here with BigInt
//      math instead of floats, since this value is going on-chain and
//      needs exact fixed-point precision, not a UI-display approximation).
//   2. Submits it to InayaOracleAdapter (Demo 1). If it's too soon since
//      the last submission (the Registry's configured minimum interval),
//      that's InayaOracleAdapter's on-chain validation doing its job --
//      logged and skipped, not a failure.
//   3. Checks InayaOracleAdapter.isStale() before treating the price as
//      usable for anything downstream (Demo 3/4's circuit-breaker check).
//   4. Reads InayaNodeRegistry's queued settlements and, for any that are
//      unlocked and unreleased, calls the ALREADY-permissionless
//      releaseSettlementsBatch() for real (Demo 2) -- this worker has no
//      special authority here, it's calling a function anyone could call.
//   5. Records the outcome on InayaAutomationRegistry either way --
//      "nothing eligible this pass" is logged as a successful check, not
//      a failure.

import { ethers } from "ethers";
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";
dotenv.config({ path: ".env" });

const RPC_URL = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const ORACLE_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS;
const ORACLE_ADAPTER_ADDRESS = process.env.NEXT_PUBLIC_ORACLE_ADAPTER_ADDRESS;
const AUTOMATION_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_AUTOMATION_REGISTRY_ADDRESS;
const NODE_REGISTRY_ADDRESS = "0xd12a38e8564d19797B19cF8F80b54DB09B3FD881";
const INAYA_USDT_PAIR_ADDRESS = "0xbf6194994a5fcdebe982026f029da5f50a255359";
const INAYA_TOKEN_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";

const PRICE_SOURCE_ID = ethers.keccak256(ethers.toUtf8Bytes("inaya-usdt-price"));
const RELEASE_TASK_ID = ethers.keccak256(ethers.toUtf8Bytes("release-node-settlements"));
const MAX_RETRIES = 3;

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const ADAPTER_ABI = [
  "function submitData(bytes32 sourceId, uint256 value, uint256 reportedTimestamp) external",
  "function isStale(bytes32 sourceId) view returns (bool)",
  "function getLatestData(bytes32 sourceId) view returns (uint256 value, uint256 reportedTimestamp, uint256 submittedAt)",
];
const NODE_REGISTRY_ABI = [
  "function getQueuedSettlementsCount() view returns (uint256)",
  "function queuedSettlements(uint256) view returns (address operator, uint256 amount, uint256 unlockTime, bool released)",
  "function releaseSettlementsBatch(uint256[] calldata settlementIds) external",
];
const AUTOMATION_REGISTRY_ABI = [
  "function recordExecution(bytes32 taskId, bool success, uint256 nextEligible, bytes32 txHash) external",
];

// Pure decision logic, exported so scripts/test-automation-worker.mjs can
// assert the SOW's 4 named demo scenarios deterministically -- no live
// network/chain calls needed to prove this logic is correct.

/** Demo 2 (Conditional Automation): a settlement is eligible once its
 *  timelock has passed and it hasn't already been released. */
export function isSettlementEligible(settlement, nowSeconds) {
  return !settlement.released && nowSeconds >= Number(settlement.unlockTime);
}

/** Demo 3 (Failed/Stale Data): once oracle data is stale, anything that
 *  depends on it should not execute -- this is the circuit-breaker check
 *  itself, independent of how staleness was determined on-chain. */
export function shouldSkipForStaleness(isStale) {
  return isStale === true;
}

/** Demo 1 (Oracle Update) validity pre-check, mirroring the on-chain
 *  require()s in InayaOracleAdapter.submitData() so the worker can decide
 *  whether a submission is even worth attempting before spending gas on a
 *  transaction that would revert. */
export function isSubmissionValid({ reportedTimestamp, nowSeconds, maxStalenessSeconds, lastSubmittedAt, minIntervalSeconds }) {
  if (reportedTimestamp > nowSeconds) return { valid: false, reason: "future timestamp" };
  if (nowSeconds - reportedTimestamp > maxStalenessSeconds) return { valid: false, reason: "already stale at submission time" };
  if (lastSubmittedAt > 0 && nowSeconds - lastSubmittedAt < minIntervalSeconds) return { valid: false, reason: "faster than minimum interval" };
  return { valid: true, reason: null };
}

async function withRetries(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[${label}] attempt ${attempt}/${MAX_RETRIES} failed: ${err.shortMessage || err.message}`);
    }
  }
  throw lastErr;
}

/** Exact BigInt fixed-point math (18-decimal), not floats -- this value is
 *  going on-chain and needs exact precision, unlike a UI display figure. */
async function getLiveInayaPriceUsdt18(provider) {
  const pair = new ethers.Contract(INAYA_USDT_PAIR_ADDRESS, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const isInayaToken0 = token0 === INAYA_TOKEN_ADDRESS.toLowerCase();
  const inayaReserve = isInayaToken0 ? reserve0 : reserve1;
  const usdtReserve = isInayaToken0 ? reserve1 : reserve0;

  if (inayaReserve === 0n) throw new Error("Pool has zero INAYA reserve -- cannot price.");
  return (usdtReserve * 10n ** 18n) / inayaReserve;
}

async function runOracleUpdate(provider, wallet) {
  console.log("\n--- Oracle update: INAYA/USDT price ---");
  const priceScaled = await getLiveInayaPriceUsdt18(provider);
  console.log(`Live spot price (18-decimal fixed point): ${priceScaled.toString()} (${ethers.formatUnits(priceScaled, 18)} USDT per INAYA)`);

  const adapter = new ethers.Contract(ORACLE_ADAPTER_ADDRESS, ADAPTER_ABI, wallet);
  const [, , lastSubmittedAt] = await adapter.getLatestData(PRICE_SOURCE_ID);
  const timestamp = Math.floor(Date.now() / 1000);

  // Same pre-check the on-chain require()s enforce -- checked here first so
  // an expected-to-fail case (too soon since last update) logs as a clean
  // skip rather than spending gas on a transaction just to watch it revert.
  const precheck = isSubmissionValid({
    reportedTimestamp: timestamp,
    nowSeconds: timestamp,
    maxStalenessSeconds: 3600,
    lastSubmittedAt: Number(lastSubmittedAt),
    minIntervalSeconds: 300,
  });
  if (!precheck.valid) {
    console.log(`Submission skipped (pre-check): ${precheck.reason}`);
    return { submitted: false, txHash: null };
  }

  try {
    const tx = await withRetries("oracle submit", () => adapter.submitData(PRICE_SOURCE_ID, priceScaled, timestamp));
    const receipt = await tx.wait();
    console.log(`Submitted on-chain: ${receipt.hash}`);
    return { submitted: true, txHash: receipt.hash };
  } catch (err) {
    console.log(`Submission failed on-chain: ${err.shortMessage || err.message}`);
    return { submitted: false, txHash: null };
  }
}

async function runAutomationCheck(provider, wallet) {
  console.log("\n--- Automation check: InayaNodeRegistry settlements ---");
  const adapter = new ethers.Contract(ORACLE_ADAPTER_ADDRESS, ADAPTER_ABI, provider);
  const stale = await adapter.isStale(PRICE_SOURCE_ID);
  console.log(`Oracle price data stale? ${stale}`);
  if (shouldSkipForStaleness(stale)) {
    console.log("Price oracle is stale -- this pass still checks settlements (they don't depend on price), but nothing that DID depend on this oracle would run right now. This is Demo 3's circuit-breaker behavior.");
  }

  const nodeRegistry = new ethers.Contract(NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI, wallet);
  const automationRegistry = new ethers.Contract(AUTOMATION_REGISTRY_ADDRESS, AUTOMATION_REGISTRY_ABI, wallet);

  const count = await nodeRegistry.getQueuedSettlementsCount();
  console.log(`Total queued settlements ever: ${count}`);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const eligibleIds = [];
  for (let i = 0; i < count; i++) {
    const s = await nodeRegistry.queuedSettlements(i);
    if (isSettlementEligible(s, nowSeconds)) {
      eligibleIds.push(i);
    }
  }
  console.log(`Eligible (unlocked, unreleased) settlement ids: [${eligibleIds.join(", ")}]`);

  const nextEligible = Math.floor(Date.now() / 1000) + 300; // check again in 5 minutes
  if (eligibleIds.length === 0) {
    console.log("Nothing eligible this pass -- recording a clean no-op check.");
    const tx = await automationRegistry.recordExecution(RELEASE_TASK_ID, true, nextEligible, ethers.ZeroHash);
    await tx.wait();
    return { executed: false };
  }

  try {
    const tx = await withRetries("releaseSettlementsBatch", () => nodeRegistry.releaseSettlementsBatch(eligibleIds));
    const receipt = await tx.wait();
    console.log(`Released ${eligibleIds.length} settlement(s) on-chain: ${receipt.hash}`);
    await (await automationRegistry.recordExecution(RELEASE_TASK_ID, true, nextEligible, receipt.hash)).wait();
    return { executed: true, txHash: receipt.hash };
  } catch (err) {
    console.error(`Settlement release failed after retries: ${err.shortMessage || err.message}`);
    await (await automationRegistry.recordExecution(RELEASE_TASK_ID, false, nextEligible, ethers.ZeroHash)).wait();
    return { executed: false, error: err.message };
  }
}

async function main() {
  if (!PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is not set.");
  if (!ORACLE_REGISTRY_ADDRESS || !ORACLE_ADAPTER_ADDRESS || !AUTOMATION_REGISTRY_ADDRESS) {
    throw new Error("NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS / NEXT_PUBLIC_ORACLE_ADAPTER_ADDRESS / NEXT_PUBLIC_AUTOMATION_REGISTRY_ADDRESS must be set -- run scripts/deploy-oracle-automation.js first.");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Automation worker running as:", wallet.address);

  await runOracleUpdate(provider, wallet);
  await runAutomationCheck(provider, wallet);

  console.log("\nWorker pass complete.");
}

// Only auto-run when this file is executed directly (`node
// automation-worker.mjs`) -- scripts/test-automation-worker.mjs imports
// this same file for its pure functions (isSettlementEligible etc.) and
// must NOT trigger a real network/chain run just by importing it.
// pathToFileURL (not a hand-rolled string) so this compares correctly on
// Windows, where a naive "file://" + path comparison gets the number of
// slashes wrong for a drive-letter path.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Worker pass failed:", err);
    process.exitCode = 1;
  });
}
