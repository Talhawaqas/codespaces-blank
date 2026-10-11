// scripts/infrastructure/check-duplicate-capabilities.mjs
//
// Sovereign Infrastructure Fabric SOW §318 -- a development-safety script,
// not a runtime authorization check. Before adding a new infrastructure
// capability, this scans the areas of the codebase the SOW's §6 names as
// REUSE targets and flags anything that looks like it might already solve
// the same problem, so a human (or Claude Code, per §319's "stop and
// produce a reuse recommendation" rule) catches an accidental duplicate
// before it's built, not after.
//
// This is a heuristic filename/export scanner, not a proof. It cannot
// catch semantic duplication (two differently-named functions that do the
// same thing) -- it catches the common case: a new file whose name or
// exports collide with something that already exists in a directory this
// SOW is supposed to be extending, not duplicating.
//
// Run with: node scripts/infrastructure/check-duplicate-capabilities.mjs

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

// One entry per SOW §6 reuse target: the directory/file this SOW must
// extend, and keywords that would indicate a new file is reinventing it.
const REUSE_TARGETS = [
  { area: "Storage control plane", path: "src/lib/storageResources.js", keywords: ["storageresource", "s3store", "objectstore"] },
  { area: "Storage snapshots", path: "src/lib/storageSnapshots.js", keywords: ["snapshot"] },
  { area: "Backup engine", path: "src/lib/backupEngine.js", keywords: ["backupengine", "backupscheduler"] },
  { area: "Managed database", path: "src/lib/rds", keywords: ["rds", "manageddatabase"] },
  { area: "Identity", path: "src/lib/identity", keywords: ["identitydirectory", "scimhandler"] },
  { area: "Org permission gates", path: "src/lib/orgGates.js", keywords: ["permissiongate", "accesscontrol"] },
  { area: "Audit chain", path: "src/lib/auditChain.js", keywords: ["auditchain", "eventledger"] },
  { area: "Evidence Graph", path: "src/lib/businessEvents.js", keywords: ["evidencegraph", "businessevent"] },
  { area: "Resilience engine", path: "src/lib/resilience-orchestrator.js", keywords: ["resilienceengine", "recoveryorchestrator"] },
  { area: "AI action pipeline", path: "src/lib/ai-action-requests.js", keywords: ["aiactionqueue", "approvalpipeline"] },
  { area: "AI security gateway", path: "src/lib/aiSecurity", keywords: ["aisecuritygateway", "promptguard"] },
  { area: "Terraform provider", path: "terraform-provider-inaya", keywords: ["terraformprovider"] },
  { area: "Notifications", path: "src/lib/notify/router.js", keywords: ["notificationrouter", "notifyevent"] },
  { area: "Workflow engine", path: "src/lib/workflows", keywords: ["workflowengine"] },
  { area: "Async job runner", path: "src/lib/jobs/run.js", keywords: ["jobrunner", "operationqueue"] },
  { area: "OpenAPI generator", path: "scripts/docs/generate-openapi.mjs", keywords: ["openapigenerator"] },
];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

async function main() {
  const infraDirs = [
    path.join(REPO_ROOT, "src/lib/infrastructure"),
    path.join(REPO_ROOT, "src/app/api/orgs/infrastructure"),
  ];

  const findings = [];
  for (const dir of infraDirs) {
    const files = await walk(dir);
    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => "");
      const normalized = content.toLowerCase();
      for (const target of REUSE_TARGETS) {
        const hit = target.keywords.find((kw) => normalized.includes(kw));
        if (hit) {
          findings.push({
            file: path.relative(REPO_ROOT, file),
            area: target.area,
            existingPath: target.path,
            matchedKeyword: hit,
            verdict: "DUPLICATE_SUSPECTED",
          });
        }
      }
    }
  }

  console.log(`Non-duplication scan: ${infraDirs.length} infrastructure director${infraDirs.length === 1 ? "y" : "ies"} checked against ${REUSE_TARGETS.length} reuse targets.`);
  if (findings.length === 0) {
    console.log("REUSE/EXTEND/NEW: no suspected duplicates found. (Heuristic scan -- not a proof; a human/Claude Code review is still required per SOW §319.)");
    return;
  }
  console.log(`\n${findings.length} suspected duplicate(s) -- SOW §319: stop and produce a reuse recommendation instead of completing the duplicate:\n`);
  for (const f of findings) {
    console.log(`  DUPLICATE_SUSPECTED  ${f.file}`);
    console.log(`    Looks like it may reinvent: ${f.area} (${f.existingPath})`);
    console.log(`    Matched keyword: "${f.matchedKeyword}"\n`);
  }
  process.exitCode = 1;
}

main();
