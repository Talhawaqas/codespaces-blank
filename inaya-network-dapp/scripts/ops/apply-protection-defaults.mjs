// Gives buckets and NAS shares that existed before 17 Nov 2026 the same ransomware protection new ones get
// (src/lib/protectionBackfill.js). Preview by default; --apply makes the changes. Safe to run again.
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/ops/apply-protection-defaults.mjs [--apply]
import { applyProtectionDefaults } from "../../src/lib/protectionBackfill.js";
const apply = process.argv.includes("--apply");
const r = await applyProtectionDefaults({ apply });
console.log(JSON.stringify(r, null, 2));
console.log(apply ? "Applied." : "Preview only -- run again with --apply to make these changes.");
process.exit(r.shares.errors.length || r.buckets.errors.length ? 1 : 0);
