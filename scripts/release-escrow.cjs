// scripts/release-escrow.js
//
// Scans every escrow schedule and releases the monthly payout for any that are due.
// Safe to run as often as you like (daily cron is plenty) — releaseMonthlyPayout()
// reverts on-chain if a schedule isn't due yet, and this script skips those gracefully
// rather than wasting gas on a doomed transaction.
//
// Usage: node scripts/release-escrow.js
// Cron:  0 6 * * * cd /path/to/project && node scripts/release-escrow.js >> escrow.log 2>&1

const { ethers } = require("ethers");
require("dotenv").config();

const ESCROW_ABI = [
  "function nextScheduleId() external view returns (uint256)",
  "function isReleaseDue(uint256 _scheduleId) external view returns (bool)",
  "function getSchedule(uint256 _scheduleId) external view returns (tuple(address corporate, address node, uint256 totalAmount, uint256 monthlyAmount, uint256 monthsReleased, uint256 startTimestamp, uint256 lastReleaseTimestamp, bool active))",
  "function releaseMonthlyPayout(uint256 _scheduleId) external",
  "event MonthlyReleased(uint256 indexed scheduleId, address indexed node, uint256 amount, uint256 monthNumber)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
  // Any funded wallet can call this — it's permissionless by design. Using the
  // verifier wallet here purely for convenience since it's already funded/rotated.
  const signer = new ethers.Wallet(process.env.VERIFIER_PRIVATE_KEY, provider);
  const escrow = new ethers.Contract(process.env.CORPORATE_ESCROW_ADDRESS, ESCROW_ABI, signer);

  const total = await escrow.nextScheduleId();
  console.log(`Scanning ${total} escrow schedule(s)...`);

  let released = 0;
  let skipped = 0;

  for (let id = 0n; id < total; id++) {
    const schedule = await escrow.getSchedule(id);
    if (!schedule.active) {
      skipped++;
      continue;
    }

    const due = await escrow.isReleaseDue(id);
    if (!due) {
      skipped++;
      continue;
    }

    console.log(`Schedule #${id}: due for release to ${schedule.node} (month ${Number(schedule.monthsReleased) + 1}/12)...`);
    try {
      const tx = await escrow.releaseMonthlyPayout(id);
      const receipt = await tx.wait();
      console.log(`  ✅ Released — tx ${receipt.hash}`);
      released++;
    } catch (err) {
      console.error(`  ❌ Release failed for schedule #${id}:`, err.shortMessage || err.message);
    }
  }

  console.log(`\nDone. Released: ${released}, Skipped (not due / inactive): ${skipped}`);
}

main().catch((err) => {
  console.error("Escrow release script failed:", err);
  process.exit(1);
});
