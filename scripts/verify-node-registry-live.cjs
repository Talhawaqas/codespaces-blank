// scripts/verify-node-registry-live.cjs
//
// Real transactions on the actual deployed BSC Testnet InayaNodeRegistry -- confirms the parts
// that don't require waiting out the real 36h delay (that full cycle is verified locally with
// time fast-forwarding, see verify-node-registry-local.cjs, same bytecode).

const { ethers } = require("ethers");
require("dotenv").config();

const REGISTRY_ADDRESS = "0xd12a38e8564d19797B19cF8F80b54DB09B3FD881";
const USDT_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D";

const REGISTRY_ABI = [
  "function registerNode(uint256 _capacityGB) external",
  "function queueSettlement(address _operator, uint256 _attributableRevenueUsdt) external",
  "function queueSettlementsBatch(address[] _operators, uint256[] _attributableRevenueAmounts) external",
  "function releaseSettlement(uint256 _settlementId) external",
  "function getCommissionBps(uint8 _tier) view returns (uint256)",
  "function getQueuedSettlementsCount() view returns (uint256)",
  "function queuedSettlements(uint256) view returns (address operator, uint256 amount, uint256 unlockTime, bool released)",
  "function fundReserve(uint256 _amount) external",
  "function nodes(address) view returns (address wallet, uint256 capacityGB, uint256 uptimeScore, uint8 tier, bool isRegistered, uint256 totalEarnedUsdt)",
  "event SettlementQueued(uint256 indexed settlementId, address indexed operator, uint256 amount, uint256 unlockTime)",
  "event SettlementSkipped(address indexed operator, string reason)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function balanceOf(address account) public view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545");
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider); // also owner + can act as verifier per onlyVerifier
  const treasury = new ethers.Wallet(process.env.TREASURY_WALLET_PRIVATE_KEY, provider);
  const operator = ethers.Wallet.createRandom().connect(provider);
  console.log("Test operator wallet:", operator.address);

  await (await treasury.sendTransaction({ to: operator.address, value: ethers.parseEther("0.0004") })).wait();

  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, deployer);
  const registryAsOperator = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, operator);
  const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, deployer);

  let passed = 0, failed = 0;
  function check(label, condition) { if (condition) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ ${label}`); failed++; } }

  console.log("\n--- Live commission rates ---");
  check("Entry = 3000 bps", (await registry.getCommissionBps(0)) === 3000n);
  check("Mid = 4000 bps", (await registry.getCommissionBps(1)) === 4000n);
  check("Enterprise = 5000 bps", (await registry.getCommissionBps(2)) === 5000n);

  console.log("\n--- Register + fund reserve on the live contract ---");
  await (await registryAsOperator.registerNode(50)).wait();
  const [, , , , isRegistered] = await registry.nodes(operator.address);
  check("Operator registered on-chain", isRegistered);

  await (await usdt.approve(REGISTRY_ADDRESS, ethers.MaxUint256)).wait();
  await (await registry.fundReserve(ethers.parseUnits("500", 18))).wait();

  console.log("\n--- Queue a real settlement ---");
  const tx = await registry.queueSettlement(operator.address, ethers.parseUnits("100", 18));
  const receipt = await tx.wait();
  console.log("  Tx:", receipt.hash);
  const queuedLog = receipt.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "SettlementQueued");
  check("SettlementQueued fired", !!queuedLog);
  const settlementId = queuedLog.args.settlementId;
  const [, , unlockTime] = await registry.queuedSettlements(settlementId);
  const secondsUntilUnlock = Number(unlockTime) - Math.floor(Date.now() / 1000);
  console.log(`  Settlement ${settlementId}, unlocks in ~${(secondsUntilUnlock / 3600).toFixed(1)}h`);

  console.log("\n--- Attempt immediate release (should revert -- real transaction, real gas) ---");
  try {
    await (await registry.releaseSettlement(settlementId)).wait();
    console.log("  ❌ FAIL: release succeeded immediately, should have reverted");
    failed++;
  } catch (err) {
    console.log(`  ✅ PASS: reverted as expected ("${err.reason || err.shortMessage || err.message}")`);
    passed++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`\nNOTE: settlement id ${settlementId} on the LIVE contract will genuinely unlock at ${new Date(Number(unlockTime) * 1000).toISOString()}.`);
  console.log("Calling releaseSettlement on it after that time is the real-world completion of this test.");
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error("FATAL:", err); process.exitCode = 1; });
