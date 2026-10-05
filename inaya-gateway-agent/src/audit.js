// src/audit.js -- the gateway's own tamper-evident audit log. Each event hashes the one before it, so a deleted or edited line breaks every later hash.
// Events are forwarded to Inaya, which re-verifies the chain and anchors its head in the organization's own audit trail. The local file stays authoritative
// for what happened inside the customer's network. Event details carry identifiers and counts, never file contents.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);
const stable = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`);
export const eventHash = ({ prevHash, seq, at, type, detail }) => createHash("sha256").update(`${prevHash}|${seq}|${at}|${type}|${stable(detail ?? {})}`).digest("hex");

export function openAudit(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, "audit.jsonl");
  const all = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    file,
    append(type, detail = {}, at = new Date().toISOString()) { const list = all(); const last = list.at(-1); const seq = (last?.seq || 0) + 1; const prevHash = last?.hash || GENESIS; const e = { seq, at, type, detail, prevHash, hash: eventHash({ prevHash, seq, at, type, detail }) }; fs.appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 }); return e; },
    after(seq, limit = 200) { return all().filter((e) => e.seq > seq).slice(0, limit); },
    verify() { let prev = GENESIS, n = 0; for (const e of all()) { n++; if (e.seq !== n || e.prevHash !== prev || eventHash(e) !== e.hash) return { valid: false, brokenAt: e.seq }; prev = e.hash; } return { valid: true, checked: n, head: prev }; },
  };
}
