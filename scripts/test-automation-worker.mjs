// scripts/test-automation-worker.mjs
//
// Run with: node scripts/test-automation-worker.mjs
//
// Framework-free test of automation-worker.mjs's pure decision functions --
// same pattern as scripts/test-fraud-risk.mjs (this package has no JS unit-
// test runner; Hardhat/chai in the root repo is Solidity-only). No network,
// no chain, no database -- these assertions run in milliseconds and cover
// the SOW's 4 named demo scenarios (section 9) deterministically.

import { isSettlementEligible, shouldSkipForStaleness, isSubmissionValid } from "./automation-worker.mjs";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} — ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  ok ? passed++ : failed++;
}

const NOW = 1_800_000_000; // arbitrary fixed "now" so every assertion is deterministic

console.log("=== Demo 1: Oracle Update -- submission validity pre-check ===\n");

check(
  "Fresh, on-time data is valid",
  isSubmissionValid({ reportedTimestamp: NOW, nowSeconds: NOW, maxStalenessSeconds: 3600, lastSubmittedAt: 0, minIntervalSeconds: 300 }).valid,
  true
);
check(
  "A future timestamp is rejected",
  isSubmissionValid({ reportedTimestamp: NOW + 100, nowSeconds: NOW, maxStalenessSeconds: 3600, lastSubmittedAt: 0, minIntervalSeconds: 300 }).valid,
  false
);
check(
  "Submitting faster than the minimum interval is rejected",
  isSubmissionValid({ reportedTimestamp: NOW, nowSeconds: NOW, maxStalenessSeconds: 3600, lastSubmittedAt: NOW - 60, minIntervalSeconds: 300 }).valid,
  false
);
check(
  "Submitting after the minimum interval has passed is valid again",
  isSubmissionValid({ reportedTimestamp: NOW, nowSeconds: NOW, maxStalenessSeconds: 3600, lastSubmittedAt: NOW - 301, minIntervalSeconds: 300 }).valid,
  true
);

console.log("\n=== Demo 2: Conditional Automation -- settlement eligibility ===\n");

check(
  "A settlement whose unlockTime has passed and isn't released is eligible",
  isSettlementEligible({ released: false, unlockTime: NOW - 1 }, NOW),
  true
);
check(
  "A settlement still locked (unlockTime in the future) is not eligible",
  isSettlementEligible({ released: false, unlockTime: NOW + 1 }, NOW),
  false
);
check(
  "An already-released settlement is never eligible again, even past unlockTime",
  isSettlementEligible({ released: true, unlockTime: NOW - 1 }, NOW),
  false
);
check(
  "A settlement unlocking at exactly `now` is eligible (>=, not >)",
  isSettlementEligible({ released: false, unlockTime: NOW }, NOW),
  true
);

console.log("\n=== Demo 3: Failed/Stale Data -- automation must not execute on stale data ===\n");

check("Stale oracle data means dependent work is skipped", shouldSkipForStaleness(true), true);

console.log("\n=== Demo 4: Recovery -- once data is fresh again, normal operation resumes ===\n");

check("Fresh oracle data means dependent work proceeds normally", shouldSkipForStaleness(false), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
