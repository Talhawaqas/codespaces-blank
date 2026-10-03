// Supply-chain gate: runs `npm audit` (production dependencies) for every npm package in the repo.
//
// Fails when a package has ANY critical advisory, or MORE high advisories than the baseline in
// scripts/supply-chain-baseline.json. A ratchet rather than "zero highs", because most of today's
// highs are transitive through the Solana/Wormhole SDKs with no upstream fix; the point is that the
// count can only go down. After genuinely reducing a count, run with --update-baseline.
//
// Usage: node scripts/supply-chain-check.mjs [--update-baseline]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "scripts", "supply-chain-baseline.json");

const PACKAGES = [
  "inaya-network-dapp",
  "inaya-network-dapp/custody-sdk",
  "inaya-network-dapp/ad-sync-agent",
  "inaya-migration-agent",
  "inaya-mobile",
  "inaya-desktop",
  "inaya-dapp-desktop",
  "solana",
];

function audit(dir) {
  let out;
  try {
    out = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: path.join(root, dir), encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    out = err.stdout; // npm audit exits non-zero when it finds anything; the JSON is still on stdout
  }
  const meta = JSON.parse(out).metadata?.vulnerabilities;
  if (!meta) throw new Error("no audit metadata");
  return { critical: meta.critical, high: meta.high, moderate: meta.moderate, low: meta.low };
}

const updating = process.argv.includes("--update-baseline");
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : {};
const next = {};
let failed = false;

console.log("package".padEnd(36), "crit", "high", "base", "mod", "low", "result");
for (const dir of PACKAGES) {
  if (!fs.existsSync(path.join(root, dir, "package.json"))) continue;
  if (!fs.existsSync(path.join(root, dir, "package-lock.json"))) { console.log(dir.padEnd(36), "-- no package-lock.json, skipped"); continue; }
  let result;
  try { result = audit(dir); } catch (err) { console.log(dir.padEnd(36), `audit failed: ${err.message}`); failed = true; continue; }
  next[dir] = { high: result.high };
  const base = baseline[dir]?.high ?? 0;
  const problems = [];
  if (result.critical > 0) problems.push("critical advisories present");
  if (result.high > base) problems.push(`high rose above baseline (${result.high} > ${base})`);
  if (problems.length) failed = true;
  console.log(dir.padEnd(36), String(result.critical).padStart(4), String(result.high).padStart(4), String(base).padStart(4), String(result.moderate).padStart(3), String(result.low).padStart(3), problems.length ? `FAIL: ${problems.join("; ")}` : result.high < base ? "ok (below baseline: run --update-baseline)" : "ok");
}

if (updating) {
  fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  console.log("baseline updated");
  process.exit(0);
}
process.exit(failed ? 1 : 0);
