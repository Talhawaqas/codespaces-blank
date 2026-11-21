// scripts/demo/resilience/verify.mjs -- recovery integrity verification (SOW Workstream B, Stage 7).
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/verify.mjs [--stage before|after]
// Recalculates the SHA-256 of every demo document as it is NOW - the current version in the bucket, and each side-by-side
// restored copy on the NAS share (.restored/<snapshot>/...) - and compares it with the hash recorded in the baseline evidence.
// Prints a table and saves evidence/verification-<time>.json. Exceptions are reported, never hidden.
import "./_env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEMO_EVIDENCE_DIR } from "./_env.mjs";
import { BUCKET, sha256, loadState, saveState, stamp } from "./_common.mjs";
import { getS3ObjectBody, listS3Objects } from "../../../src/lib/s3-compat/store.js";
import { NasAgentClient } from "../../../src/lib/nas/agent.js";

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "after";
const state = loadState();
if (!state.baselineFile) { console.error("No baseline evidence: seed the demo first."); process.exit(1); }
const base = JSON.parse(readFileSync(state.baselineFile, "utf8"));
const rows = [];
const line = (where, file, expected, actual) => { const ok = expected === actual; rows.push({ where, file, expected, actual, match: ok }); console.log(`${ok ? "MATCH    " : "DIFFERENT"}  ${where.padEnd(28)} ${file.padEnd(44)} ${String(actual).slice(0, 16)}...`); };

console.log(`Integrity check (${stage}) - SHA-256 of each document now vs. the baseline recorded at ${base.recordedAt}`);
for (const f of base.cloud.files) {
  let actual = "missing"; try { actual = sha256((await getS3ObjectBody({ orgId: base.company.orgId, bucket: BUCKET, key: f.key })).buffer); } catch (e) { actual = `error: ${e.message.slice(0, 40)}`; }
  line(`cloud ${BUCKET}`, f.key, f.sha256, actual);
}
let extra = [];
try { extra = ((await listS3Objects({ orgId: base.company.orgId, bucket: BUCKET }))?.contents || []).map((o) => o.filename).filter((k) => !base.cloud.files.some((f) => f.key === k) && !k.startsWith(".inaya-canary/")); } catch { /* listing is informational */ }

const agent = new NasAgentClient({ backend: "wsl-local" });
const files = await agent.listFiles({ shareName: base.nas.share, limit: 5000 }).catch(() => []);
// A side-by-side restore lands in .restored/<snapshot>/ (the agent's file listing skips hidden folders, so the baseline
// snapshot's restore folder is always checked too).
const restoredDirs = [...new Set([...files.map((f) => String(f.relativePath)).filter((p) => p.startsWith(".restored/")).map((p) => p.split("/").slice(0, 2).join("/")), `.restored/${base.nas.snapshot.name}`])];
for (const f of base.nas.files) {
  const live = await agent.readFile({ shareName: base.nas.share, relativePath: f.path }).then(sha256).catch(() => "missing");
  line(`NAS ${base.nas.share} (live)`, f.path, f.sha256, live);
  for (const d of restoredDirs) {
    const r = await agent.readFile({ shareName: base.nas.share, relativePath: `${d}/${f.path}` }).then(sha256).catch(() => "missing");
    line(`NAS ${d}`, f.path, f.sha256, r);
  }
}
const summary = {};
for (const r of rows) { const k = r.where; summary[k] = summary[k] || { match: 0, different: 0 }; summary[k][r.match ? "match" : "different"]++; }
console.log("\nSummary:"); for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(36)} ${v.match} match, ${v.different} different`);
if (extra.length) console.log(`  Files in the bucket that are not in the baseline (left by the simulation; an administrator can delete them): ${extra.join(", ")}`);
const file = path.join(DEMO_EVIDENCE_DIR, `verification-${stage}-${stamp().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ checkedAt: stamp(), stage, baseline: state.baselineFile, summary, extraFiles: extra, rows }, null, 2));
saveState({ [`lastVerification_${stage}`]: { at: stamp(), summary, file } });
console.log("Saved:", file);
process.exit(0);
