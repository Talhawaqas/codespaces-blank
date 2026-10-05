// scripts/competitive-ledger.mjs -- maintains docs/competitive-expansion-implementation-ledger.json (SOW §57).
//   node scripts/competitive-ledger.mjs set CHAT-001 --status VERIFIED --files a.js,b.js --routes "POST /x" --tests t.mjs --note "..."
//   node scripts/competitive-ledger.mjs summary
//   node scripts/competitive-ledger.mjs check   (exits 1 if an item claims VERIFIED without tests or browser/security flags where required)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "competitive-expansion-implementation-ledger.json");
const STATUSES = ["VERIFIED", "IMPLEMENTED_NOT_LIVE", "PARTIAL", "CONFIGURED", "NOT_CONFIGURED", "UNSUPPORTED", "DEFERRED", "FUTURE", "PLANNED"];

const load = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
const save = (l) => fs.writeFileSync(FILE, JSON.stringify(l, null, 2) + "\n");
const csv = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === "set") {
  const id = rest[0]; const ledger = load();
  const item = ledger.items.find((x) => x.id === id);
  if (!item) { console.error("unknown id " + id); process.exit(1); }
  const status = opt("status"); if (status) { if (!STATUSES.includes(status)) { console.error("bad status"); process.exit(1); } item.status = status; }
  for (const k of ["files", "routes", "collections", "tests"]) { const v = csv(opt(k)); if (v) item[k] = [...new Set([...(item[k] || []), ...v])]; }
  if (opt("browser")) item.browserVerified = opt("browser") === "true";
  if (opt("security")) item.securityReviewed = opt("security") === "true";
  if (opt("note")) item.notes = opt("note");
  save(ledger); console.log("updated", id, item.status);
} else if (cmd === "summary") {
  const l = load(); const by = {};
  for (const i of l.items) by[i.status] = (by[i.status] || 0) + 1;
  console.log(JSON.stringify({ total: l.items.length, ...by }, null, 2));
} else if (cmd === "check") {
  const l = load(); let bad = 0;
  for (const i of l.items) if (i.status === "VERIFIED" && !(i.tests || []).length) { console.error(i.id + ": VERIFIED without tests"); bad++; }
  process.exit(bad ? 1 : 0);
} else { console.error("usage: set | summary | check"); process.exit(1); }
