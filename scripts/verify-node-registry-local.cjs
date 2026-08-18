// scripts/verify-node-registry-local.cjs
//
// Full timelock lifecycle test on a local Hardhat network (in-memory, throwaway) -- the SAME
// compiled bytecode as the live BSC Testnet deployment, but able to fast-forward time so the
// real 36-hour SETTLEMENT_DELAY can actually be crossed and the "release succeeds after
// unlock" case can be genuinely exercised, not just asserted from reading the source.
//
// Run: npx hardhat run scripts/verify-node-registry-local.cjs --network hardhat

const hre = require("hardhat");
const { expect } = require("chai");

async function main() {
  const [deployer, verifier, operator, attacker] = await hre.ethers.getSigners();

  const MockToken = await hre.ethers.getContractFactory("MockINAYA"); // reused as a stand-in mintable ERC20
  const token = await MockToken.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const NodeRegistry = await hre.ethers.getContractFactory("InayaNodeRegistry");
  const registry = await NodeRegistry.deploy(tokenAddress, verifier.address);
  await registry.waitForDeployment();

  let passed = 0, failed = 0;
  function check(label, condition) {
    if (condition) { console.log(`  ✅ ${label}`); passed++; }
    else { console.log(`  ❌ ${label}`); failed++; }
  }
  async function expectRevert(label, promiseFactory) {
    try {
      await promiseFactory();
      console.log(`  ❌ ${label}: expected revert, but succeeded`);
      failed++;
    } catch (err) {
      console.log(`  ✅ ${label}: reverted as expected ("${err.reason || err.shortMessage || err.message}")`);
      passed++;
    }
  }

  console.log("\n--- Commission rates (30/40/50) ---");
  check("Entry = 3000 bps (30%)", (await registry.getCommissionBps(0)) === 3000n);
  check("Mid = 4000 bps (40%)", (await registry.getCommissionBps(1)) === 4000n);
  check("Enterprise = 5000 bps (50%)", (await registry.getCommissionBps(2)) === 5000n);

  console.log("\n--- Setup: register operator, fund reserve ---");
  await (await registry.connect(operator).registerNode(100)).wait();
  await (await token.mint(deployer.address, hre.ethers.parseEther("10000"))).wait();
  await (await token.approve(await registry.getAddress(), hre.ethers.MaxUint256)).wait();
  await (await registry.fundReserve(hre.ethers.parseEther("10000"))).wait();
  const reserveBefore = await token.balanceOf(await registry.getAddress());
  console.log("  Reserve funded:", hre.ethers.formatEther(reserveBefore));

  console.log("\n--- Queue a settlement (should NOT transfer immediately) ---");
  const opBalanceBeforeQueue = await token.balanceOf(operator.address);
  const tx = await registry.connect(verifier).queueSettlement(operator.address, hre.ethers.parseEther("1000"));
  const receipt = await tx.wait();
  const opBalanceAfterQueue = await token.balanceOf(operator.address);
  check("Operator balance unchanged immediately after queueSettlement", opBalanceAfterQueue === opBalanceBeforeQueue);

  const queuedEvent = receipt.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "SettlementQueued");
  check("SettlementQueued event fired", !!queuedEvent);
  const settlementId = queuedEvent.args.settlementId;
  const expectedAmount = (hre.ethers.parseEther("1000") * 3000n) / 10000n; // 30% Entry tier
  check(`Queued amount is 30% of revenue (${hre.ethers.formatEther(expectedAmount)})`, queuedEvent.args.amount === expectedAmount);

  console.log("\n--- Attempt to release BEFORE unlock time (should revert) ---");
  await expectRevert("releaseSettlement before delay", () => registry.connect(attacker).releaseSettlement(settlementId));

  console.log("\n--- Fast-forward past SETTLEMENT_DELAY (36h) ---");
  await hre.network.provider.send("evm_increaseTime", [36 * 60 * 60 + 60]); // 36h + 60s buffer
  await hre.network.provider.send("evm_mine");

  console.log("\n--- Release AFTER unlock time (should succeed, callable by anyone) ---");
  const opBalanceBeforeRelease = await token.balanceOf(operator.address);
  await (await registry.connect(attacker).releaseSettlement(settlementId)).wait(); // note: attacker calls it, not the operator -- confirms "publicly callable"
  const opBalanceAfterRelease = await token.balanceOf(operator.address);
  check("Operator received the queued amount", opBalanceAfterRelease - opBalanceBeforeRelease === expectedAmount);

  console.log("\n--- Attempt to release the SAME settlement again (should revert) ---");
  await expectRevert("double release", () => registry.releaseSettlement(settlementId));

  console.log("\n--- SettlementSkipped: all three skip conditions in queueSettlementsBatch ---");
  const unregisteredAddr = hre.ethers.Wallet.createRandom().address;
  const batchTx = await registry.connect(verifier).queueSettlementsBatch(
    [unregisteredAddr, operator.address, operator.address],
    [hre.ethers.parseEther("100"), 0, hre.ethers.parseEther("999999999")] // not registered / zero revenue / would exceed reserve
  );
  const batchReceipt = await batchTx.wait();
  const skips = batchReceipt.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "SettlementSkipped");
  check("3 SettlementSkipped events fired", skips.length === 3);
  check("reason: not registered", skips.some((s) => s.args.reason === "not registered"));
  check("reason: zero revenue", skips.some((s) => s.args.reason === "zero revenue"));
  check("reason: insufficient reserve", skips.some((s) => s.args.reason === "insufficient reserve"));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? "✅ ALL LOCAL TIMELOCK CHECKS PASSED" : "❌ SOME CHECKS FAILED");
  console.log("=".repeat(60));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error("FATAL:", err); process.exitCode = 1; });
