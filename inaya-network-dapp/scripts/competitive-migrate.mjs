// scripts/competitive-migrate.mjs -- additive migration check for the Competitive Expansion SOW (MIGRATE-001, SOW section 55).
//
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/competitive-migrate.mjs            dry run (default): reads only, changes nothing
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/competitive-migrate.mjs --apply    creates the indexes the new modules need, by exercising each module's own index setup
//
// What this is and is not:
//   * Everything the SOW added is ADDITIVE: new collections and new optional fields. No existing field is renamed, retyped or removed, and nothing here writes to an existing collection's documents.
//   * Each new module creates its own indexes the first time it is used (idempotent createIndex). `--apply` triggers that ahead of time so the first real request does not pay for it, and so a bad index definition surfaces now.
//   * The dry run reports, per new collection, whether it exists, how many documents it holds and how many indexes it has, and whether every feature flag is still off by default.
//   * Rollback is a flag switch, not a data operation (docs/runbooks/competitive-rollback.md). This script never drops a collection or index.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOrgCollections } from "../src/lib/orgs.js";
import { FEATURES, envFlag } from "../src/lib/featureFlags.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib");
const apply = process.argv.includes("--apply");
const DIRS = ["chat", "notes", "sharing", "governance", "dataroom", "endpoint", "devices", "ransomware", "gateway", "ha", "integrations", "support", "compliance", "keys", "jobs", "metrics", "webhooks", "notify", "branding", "filerequests", "admin"];
const FILES = ["filePrefs.js"];

function sources() { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) out.push(p); } }; for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d)); for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(path.join(ROOT, f)); return out; }
function discover() { const names = new Map(); for (const f of sources()) { const s = fs.readFileSync(f, "utf8"); for (const m of s.matchAll(/\.collection\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g)) { (names.get(m[1]) || names.set(m[1], new Set()).get(m[1])).add(path.relative(ROOT, f).replace(/\\/g, "/")); } } return names; }

// Cheap, read-only entry points that make a module run its own index setup. Each is tried independently; a failure is reported, never hidden.
const WARM = [
  ["jobs", async () => (await import("../src/lib/jobs/run.js")).listRuns({ limit: 1 })],
  ["metrics", async () => (await import("../src/lib/metrics/metrics.js")).record("chat.message_sent", { orgId: null, value: 0 })],
  ["gateway", async () => (await import("../src/lib/gateway/gateway.js")).gwCols()],
  ["compliance", async () => { const m = await import("../src/lib/compliance/implementation.js"); return m.listControls({ orgId: "000000000000000000000000", membership: { role: "owner" }, limit: 1 }); }],
  ["keys", async () => (await import("../src/lib/keys/service.js")).getConfig("000000000000000000000000")],
];

const { db } = await getOrgCollections();
const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
const report = { mode: apply ? "apply" : "dry-run", warmed: [], collections: [], flags: [] };

if (apply) for (const [name, fn] of WARM) { try { await fn(); report.warmed.push({ module: name, ok: true }); } catch (e) { report.warmed.push({ module: name, ok: false, note: String(e?.message || e).slice(0, 120) + " (this module creates its indexes on first use instead)" }); } }
const after = apply ? new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)) : existing;

for (const [name, files] of [...discover()].sort(([a], [b]) => a.localeCompare(b))) {
  const present = after.has(name); let docs = null, indexes = null;
  if (present) { try { docs = await db.collection(name).estimatedDocumentCount(); indexes = (await db.collection(name).indexes()).length; } catch { /* unreadable: leave null */ } }
  report.collections.push({ name, exists: present, documents: docs, indexes, usedBy: [...files].slice(0, 3) });
}
const orgs = db.collection("orgs");
for (const f of FEATURES) { const env = envFlag(f); report.flags.push({ flag: f, env: env || "unset", organizationsOptedIn: await orgs.countDocuments({ [`features.${f}`]: true }) }); }

const envOn = report.flags.filter((f) => f.env === "on").map((f) => f.flag);
const missing = report.collections.filter((c) => !c.exists).length;
console.log(JSON.stringify(report, null, 2));
console.log(`\n${report.collections.length} collections referenced by the new modules; ${report.collections.length - missing} exist now${missing ? `, ${missing} are created on first use (MongoDB creates a collection on first write or index)` : ""}.`);
console.log(envOn.length ? `NOTE: these flags are forced ON for every organization by the environment: ${envOn.join(", ")}.` : "Every feature flag is unset in this environment, so each stays off until an organization opts in (default-off confirmed).");
if (!apply) console.log("Dry run only: nothing was changed. Re-run with --apply to create indexes ahead of first use.");
process.exit(0);
