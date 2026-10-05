#!/usr/bin/env node
// bin/inaya-gateway.mjs -- launcher and command line for the Inaya Sovereign Gateway agent.
//
//   inaya-gateway enroll --url https://app.inaya.network --token gwe_... [--label "Head office"]
//   inaya-gateway run                      run continuously (poll interval from Inaya, default 30 s)
//   inaya-gateway once                     one cycle, then exit
//   inaya-gateway status                   local state: queue depth, last cycle, audit chain check, version
//   inaya-gateway restore <transferId> --out <file>     read a completed transfer back and decrypt it locally
//   inaya-gateway set <key> <value>        bandwidthKbps | scanIntervalSeconds | aclIntervalSeconds | releasePublicKey | directory (file:<path> | windows-local)
//
// The passphrase that protects the local keys comes from INAYA_GATEWAY_PASSPHRASE. Data directory: INAYA_GATEWAY_HOME.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { defaultDir, loadConfig, saveConfig } from "../src/config.js";
import { chooseVersion } from "../src/upgrade.js";

const dir = defaultDir(); const argv = process.argv.slice(2); const cmd = argv[0];
const opt = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const pass = () => { const p = process.env.INAYA_GATEWAY_PASSPHRASE; if (!p) { console.error("Set INAYA_GATEWAY_PASSPHRASE (at least 8 characters). It protects the gateway's private key on this machine."); process.exit(1); } return p; };

// A staged upgrade is run from versions/<current>; the launcher falls back by itself if a new version never confirms a healthy cycle.
const picked = chooseVersion(dir); const entry = picked.version && fs.existsSync(path.join(dir, "versions", picked.version, "src", "agent.js")) ? path.join(dir, "versions", picked.version, "src") : new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const mod = (f) => import(pathToFileURL(path.join(entry, f)).href);

async function main() {
  if (cmd === "enroll") {
    const { enrollGateway } = await mod("client.js"); const { CAPABILITIES, VERSION } = await mod("agent.js"); const url = opt("url"), token = opt("token"); if (!url || !token) { console.error("--url and --token are required."); process.exit(1); }
    const r = await enrollGateway({ baseUrl: url, token, label: opt("label"), version: VERSION, platform: `${os.platform()}-${os.arch()}`, capabilities: CAPABILITIES });
    const f = saveConfig(dir, { baseUrl: url, gatewayId: r.gatewayId, privateKeyPem: r.privateKeyPem, dataKey: randomBytes(32).toString("base64"), bandwidthKbps: 0, scanIntervalSeconds: 300, aclIntervalSeconds: 900 }, pass());
    console.log(`Registered gateway ${r.gatewayId} (key fingerprint ${r.fingerprint}). Configuration saved, encrypted, to ${f}.`); return;
  }
  const config = loadConfig(dir, pass()); if (!config) { console.error("This machine is not enrolled. Run: inaya-gateway enroll --url ... --token ..."); process.exit(1); }
  const { makeClient, RevokedError } = await mod("client.js"); const { openQueue } = await mod("queue.js"); const { openAudit } = await mod("audit.js"); const { runOnce, VERSION } = await mod("agent.js");
  const client = makeClient({ baseUrl: config.baseUrl, gatewayId: config.gatewayId, privateKeyPem: config.privateKeyPem }); const queue = openQueue(dir); const audit = openAudit(dir);
  if (cmd === "status") { console.log(JSON.stringify({ gatewayId: config.gatewayId, version: VERSION, running: picked, queueDepth: queue.depth(), audit: audit.verify(), state: fs.existsSync(path.join(dir, "state.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) : null }, null, 2)); return; }
  if (cmd === "set") { const [k, v] = [argv[1], argv[2]]; const ok = ["bandwidthKbps", "scanIntervalSeconds", "aclIntervalSeconds", "releasePublicKey", "directory"]; if (!ok.includes(k) || v === undefined) { console.error(`Usage: set <${ok.join("|")}> <value>`); process.exit(1); } config[k] = k === "directory" ? (v === "windows-local" ? { type: "windows-local" } : v.startsWith("file:") ? { type: "file", path: v.slice(5) } : (() => { throw new Error("directory must be windows-local or file:<path>"); })()) : k === "releasePublicKey" ? v : Number(v); saveConfig(dir, config, pass()); console.log(`${k} updated.`); return; }
  if (cmd === "restore") { const { restoreTransfer } = await mod("transfer.js"); const out = opt("out"); if (!argv[1] || !out) { console.error("Usage: restore <transferId> --out <file>"); process.exit(1); } const bytes = await restoreTransfer({ client, transferId: argv[1], dataKey: Buffer.from(config.dataKey, "base64") }); fs.writeFileSync(out, bytes); audit.append("restore.completed", { transferId: argv[1], size: bytes.length }); console.log(`Restored ${bytes.length} bytes to ${out}.`); return; }
  const fetchBytes = async (a) => { const u = new URL(a.url); if (u.protocol !== "https:") throw new Error("Upgrade packages must be fetched over https."); const r = await fetch(u); if (!r.ok) throw new Error(`Download failed (${r.status}).`); return Buffer.from(await r.arrayBuffer()); };
  const cycle = () => runOnce({ client, config, dir, audit, queue, fetchBytes, log: (m) => console.log(m) });
  if (cmd === "once") { console.log(JSON.stringify(await cycle())); return; }
  if (cmd === "run") {
    for (;;) { try { await cycle(); } catch (e) { if (e instanceof RevokedError) { console.error(e.message + " The gateway will stop."); audit.append("gateway.revoked", {}); process.exit(2); } console.error(`Cycle failed: ${e.message}`); } await new Promise((r) => setTimeout(r, 30_000)); }
  }
  console.error("Usage: inaya-gateway enroll | run | once | status | restore | set"); process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
