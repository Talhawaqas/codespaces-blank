// src/agent.js -- one cycle of the gateway: report health, learn the approved configuration, list approved folders, read their permissions, forward the audit
// trail, carry out approved transfers and queued commands. Everything leaves through the offline queue, so an unreachable Inaya costs time, not data.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanFolder, connectorHealth, resolveInside } from "./connectors.js";
import { readAcl } from "./acl.js";
import { load as loadDirectory } from "./directory.js";
import { uploadTransfer, makeThrottle } from "./transfer.js";
import { stageUpgrade, rollback, confirmHealthy } from "./upgrade.js";
import { RevokedError } from "./client.js";

export const VERSION = "0.1.0";
export const CAPABILITIES = ["filesystem", "smb-path", "nfs-mount", "ntfs-acl", "posix-mode", "encrypted-transfer", "audit-forwarding", "offline-queue", "signed-upgrade"];

export function makeClassifier(rules = []) {
  if (!rules.length) return null;
  return (e) => { for (const r of rules) { const name = String(e.path).toLowerCase(); const ext = name.includes(".") ? name.split(".").pop() : ""; if ((r.extensions || []).map((x) => String(x).toLowerCase().replace(/^\./, "")).includes(ext) || (r.nameContains || []).some((s) => name.includes(String(s).toLowerCase()))) return r.level; } return null; };
}
const readState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")); } catch { return { auditAckSeq: 0, lastScan: {}, lastAcl: {}, aclFailures: 0 }; } };
const writeState = (dir, s) => { fs.writeFileSync(path.join(dir, "state.json") + ".tmp", JSON.stringify(s)); fs.renameSync(path.join(dir, "state.json") + ".tmp", path.join(dir, "state.json")); };

export async function runOnce({ client, config, dir, audit, queue, log = () => {}, now = Date.now(), fetchBytes = null, hooks = {} }) {
  const state = readState(dir); const dataKey = Buffer.from(config.dataKey, "base64"); const throttle = makeThrottle({ kbps: config.bandwidthKbps || 0 });
  const started = now; let hb;
  hb = await client.post("/api/gateway/v1/heartbeat", { version: VERSION, platform: `${os.platform()}-${os.arch()}`, capabilities: CAPABILITIES, connectors: state.lastConnectors || [], queueDepth: queue.depth(), lagSeconds: state.lastCycleAt ? Math.round((started - state.lastCycleAt) / 1000) : 0, aclFailures: state.aclFailures || 0, uptimeSeconds: Math.round(process.uptime()), bandwidthKbps: config.bandwidthKbps || null });
  const force = new Set(hb.commands.map((c) => c.type)); const classify = makeClassifier(config.classificationRules);
  const connectorState = []; let aclFailures = 0; const directory = (() => { try { return loadDirectory(config.directory); } catch (e) { log(`directory source failed: ${e.message}`); return []; } })();

  for (const c of hb.commands) {
    audit.append("command.received", { type: c.type });
    if (c.type === "rollback") { const r = rollback(path.join(dir)); audit.append("agent.rollback", r); }
    if (c.type === "upgrade") {
      try {
        if (!fetchBytes) throw new Error("No package downloader is available."); const bytes = await fetchBytes(c.args);
        const r = stageUpgrade({ dir, manifest: { version: c.args.version, sha256: c.args.sha256, size: c.args.size, signature: c.args.signature }, bytes, releasePublicKey: config.releasePublicKey });
        audit.append(r.staged ? "agent.upgrade.staged" : "agent.upgrade.refused", r.staged ? { version: r.version, previous: r.previous } : { reason: r.reason });
      } catch (e) { audit.append("agent.upgrade.failed", { reason: String(e.message).slice(0, 120) }); }
    }
  }

  for (const k of hb.connectors) {
    const h = k.enabled === false ? { status: "disabled", lastError: null } : connectorHealth({ rootPath: k.rootPath }); const entry = { connectorId: k.connectorId, status: h.status, lastError: h.lastError, lastScanAt: null };
    if (h.status === "ok") for (const f of k.folders) {
      const due = force.has("rescan") || !state.lastScan[f.folderId] || started - state.lastScan[f.folderId] >= (config.scanIntervalSeconds ?? 300) * 1000;
      if (due) {
        try {
          const r = await scanFolder({ rootPath: k.rootPath, folderPath: f.path, classify }); const scanId = `${started}-${f.folderId}`; const pages = []; for (let i = 0; i < Math.max(1, r.entries.length); i += 1000) pages.push(r.entries.slice(i, i + 1000));
          pages.forEach((p, i) => queue.push("inventory", { connectorId: k.connectorId, folderId: f.folderId, entries: p, scanId, complete: i === pages.length - 1 && !r.truncated }, `inv:${f.folderId}:${i}`));
          state.lastScan[f.folderId] = started; entry.lastScanAt = new Date(started).toISOString(); audit.append("scan.completed", { folderId: f.folderId, entries: r.entries.length, skipped: r.skipped });
        } catch (e) { entry.status = "degraded"; entry.lastError = String(e.message).slice(0, 120); audit.append("scan.failed", { folderId: f.folderId, reason: entry.lastError }); }
      }
      const aclDue = force.has("acl_refresh") || !state.lastAcl[f.folderId] || started - state.lastAcl[f.folderId] >= (config.aclIntervalSeconds ?? 900) * 1000;
      if (aclDue) {
        const a = readAcl(resolveInside(k.rootPath, f.path));
        if (a.ok) { queue.push("acl", { folderId: f.folderId, entries: a.entries, principals: directory, source: a.source, takenAt: new Date(started).toISOString() }, `acl:${f.folderId}`); state.lastAcl[f.folderId] = started; audit.append("acl.read", { folderId: f.folderId, entries: a.entries.length, source: a.source }); }
        else { aclFailures++; audit.append("acl.failed", { folderId: f.folderId, reason: a.error }); }
      }
    }
    connectorState.push(entry);
  }
  state.aclFailures = aclFailures; state.lastConnectors = connectorState; state.lastCycleAt = started;

  for (const t of hb.transfers.filter((x) => x.status === "requested" || x.status === "uploading")) {
    const k = hb.connectors.find((c) => c.connectorId === t.connectorId); const f = k?.folders.find((x) => x.folderId === t.folderId); if (!k || !f) continue;
    try { const r = await uploadTransfer({ client, transfer: t, rootPath: k.rootPath, folderPath: f.path, dataKey, throttle, hooks }); audit.append("transfer.completed", { transferId: t.transferId, size: r.size, parts: r.parts, resumedFrom: r.resumedFrom }); }
    catch (e) { if (e instanceof RevokedError) throw e; audit.append("transfer.failed", { transferId: t.transferId, reason: String(e.message).slice(0, 120) }); log(`transfer ${t.transferId} will be retried: ${e.message}`); }
  }

  const sent = await queue.flush(async (it) => { await client.post(`/api/gateway/v1/${it.type}`, it.payload); });
  // audit forwarding, resumable from whatever Inaya last accepted
  for (let guard = 0; guard < 10; guard++) {
    const batch = audit.after(state.auditAckSeq); if (!batch.length) break;
    try { const r = await client.post("/api/gateway/v1/events", { events: batch }); state.auditAckSeq = r.seq; }
    catch (e) { if (e.status === 409 && e.body?.expectedSeq) { state.auditAckSeq = e.body.expectedSeq - 1; continue; } if (e.network || e.status >= 500) break; throw e; }
  }
  writeState(dir, state); confirmHealthy(dir);
  return { queued: queue.depth(), flushed: sent.sent, connectors: connectorState, auditAckSeq: state.auditAckSeq };
}
