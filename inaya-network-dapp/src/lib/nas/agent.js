// src/lib/nas/agent.js
//
// Sovereign NAS SOW, Workstream A (appliance/edge runtime) and Section 37
// (command-injection prevention).
//
// The control plane never builds a shell string. Every appliance operation is
// one JSON request file handed to the appliance-side agent
// (src/lib/nas/appliance/inaya-nas-agent.py, installed at
// /usr/local/sbin/inaya-nas-agent.py) which validates every name/path/CIDR and
// runs commands as argv lists. Request and response are JSON; secrets travel
// only inside the (deleted-after-use) request file, never on a command line.
//
// Supported backend, stated plainly (SOW 36A.1): a Linux appliance -- Samba
// 4.23, nfs-kernel-server, mdadm, Btrfs, ext4 quotas -- reached through this
// host's WSL2 distro via wsl.exe. A physical or remote appliance would run the
// same agent behind an authenticated local API; only "wsl-local" is implemented
// and tested, and any other backend is an explicit error, not a silent no-op.
//
// Important deployment fact: the control plane must run on (or be able to run
// wsl.exe against) the appliance host. The hosted website cannot reach a NAS
// sitting behind a customer's router; see docs/sovereign-nas-report.md.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const WSL_DISTRO = process.env.NAS_WSL_DISTRO || "Ubuntu";
export const NAS_ROOT = "/srv/inaya-nas";
const AGENT_PATH = "/usr/local/sbin/inaya-nas-agent.py";

/** Windows path -> the /mnt/<drive>/... path WSL2 always exposes. */
export function winPathToWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, "/");
  const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (!match) throw new Error(`Cannot map non-drive-letter path into WSL: ${winPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

async function wsl(args, { timeout = 30000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("wsl.exe", ["-d", WSL_DISTRO, "-u", "root", "--", ...args], { timeout, maxBuffer });
    return { stdout, stderr };
  } catch (err) {
    const e = new Error(`NAS agent command failed: ${args[0]} — ${err.stderr || err.message}`);
    e.code = "WSL_FAILED";
    e.stdout = err.stdout || "";
    throw e;
  }
}

export async function getBundledAgentInfo() {
  const source = await fs.readFile(agentSourcePath());
  const m = source.toString("utf8").match(/^AGENT_VERSION\s*=\s*"([^"]+)"/m);
  return { version: m ? m[1] : null, sha256: createHash("sha256").update(source).digest("hex") };
}

function agentSourcePath() {
  return path.join(process.cwd(), "src", "lib", "nas", "appliance", "inaya-nas-agent.py");
}

let agentReady = null;

export class NasAgentClient {
  constructor({ backend = "wsl-local" } = {}) {
    if (backend !== "wsl-local") {
      throw new Error(`NAS agent backend "${backend}" is not implemented in this pass — only "wsl-local" (this appliance profile) is real. See src/lib/nas/agent.js's header.`);
    }
    this.backend = backend;
  }

  /** Ensures the appliance-side agent exists. It installs when missing, and
   *  refreshes it when it differs from this repository's copy UNLESS
   *  NAS_AGENT_MANAGED_UPDATES=1 (production): then updating is a deliberate,
   *  pre-checked operation (updates.js) and a stale agent is only reported. */
  async ensureAgent() {
    if (!agentReady) {
      agentReady = (async () => {
        const { sha256: expected } = await getBundledAgentInfo();
        try {
          const v = await this.rawCall("version", {});
          if (v.agentSha256 === expected) return { installed: false, sha256: expected, ...v };
          if (process.env.NAS_AGENT_MANAGED_UPDATES === "1") return { installed: false, outdated: true, sha256: expected, ...v };
        } catch {
          // not installed yet
        }
        return this.installAgent({ keepPrevious: true });
      })().catch((e) => { agentReady = null; throw e; });
    }
    return agentReady;
  }

  /** Installs the repository's agent, keeping the previous copy for rollback. */
  async installAgent({ keepPrevious = true } = {}) {
    const info = await getBundledAgentInfo();
    const source = await fs.readFile(agentSourcePath());
    if (keepPrevious) await wsl(["cp", "-f", AGENT_PATH, AGENT_PATH + ".prev"]).catch(() => {});
    const tmp = path.join(os.tmpdir(), `inaya-nas-${randomUUID()}.bin`);
    await fs.writeFile(tmp, source);
    try {
      await wsl(["install", "-D", "-m", "0750", winPathToWslPath(tmp), AGENT_PATH]);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    agentReady = null;
    const v = await this.rawCall("version", {});
    if (v.agentSha256 !== info.sha256) throw new Error("Agent install verification failed: the installed agent does not match the repository copy.");
    agentReady = Promise.resolve({ installed: true, sha256: info.sha256, ...v });
    return agentReady;
  }

  /** Restores the agent copy saved by the last install. */
  async rollbackAgent() {
    await wsl(["cp", "-f", AGENT_PATH + ".prev", AGENT_PATH]);
    agentReady = null;
    return this.rawCall("version", {});
  }

  /** What is installed on the appliance right now (no auto-install). */
  async installedAgent() {
    try { return await this.rawCall("version", {}); } catch { return null; }
  }

  async rawCall(op, params, { timeout = 30000 } = {}) {
    const tmp = path.join(os.tmpdir(), `inaya-nas-${randomUUID()}.json`);
    await fs.writeFile(tmp, JSON.stringify({ op, params }), { mode: 0o600 });
    try {
      const { stdout } = await wsl(["python3", AGENT_PATH, winPathToWslPath(tmp)], { timeout });
      let parsed;
      try { parsed = JSON.parse(stdout.trim().split("\n").pop()); } catch { throw Object.assign(new Error("The NAS agent returned an unreadable response."), { code: "BAD_RESPONSE" }); }
      if (!parsed.ok) throw Object.assign(new Error(parsed.error || "NAS agent error"), { code: parsed.code || "AGENT_ERROR" });
      if (parsed.bootRecovery) {
        // First call after an appliance restart: the agent re-mounted pools
        // and restarted services. Keep the latest report for evidence/UI.
        NasAgentClient.lastBootRecovery = { at: new Date().toISOString(), ...parsed.bootRecovery };
      }
      return parsed.result;
    } catch (err) {
      // The agent exits non-zero for a refused operation but still prints a
      // structured JSON error; surface that instead of a generic failure.
      if (err.code === "WSL_FAILED" && err.stdout) {
        try {
          const parsed = JSON.parse(String(err.stdout).trim().split("\n").pop());
          if (parsed && parsed.ok === false) throw Object.assign(new Error(parsed.error || "NAS agent error"), { code: parsed.code || "AGENT_ERROR", errno: parsed.errno });
        } catch (inner) {
          if (inner.code && inner.code !== "WSL_FAILED" && !(inner instanceof SyntaxError)) throw inner;
        }
      }
      if (err.code === "WSL_FAILED" && /No such file|can't open file/.test(err.message)) agentReady = null;
      throw err;
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  /** Runs one validated appliance operation. */
  async call(op, params = {}, opts = {}) {
    await this.ensureAgent();
    return this.rawCall(op, params, opts);
  }

  /** WSL2 stops its VM when idle, which unmounts pools and stops Samba/NFS.
   *  A physical or always-on appliance does not do this; on this VM profile
   *  a background `sleep` keeps the distro up. Opt-in, returns the process. */
  static startKeepAlive() {
    const cur = NasAgentClient._keepAlive;
    if (cur && cur.exitCode === null && !cur.killed) return cur; // still running; a killed VM ends it, so it is respawned
    const child = spawn("wsl.exe", ["-d", WSL_DISTRO, "-u", "root", "--", "sleep", "infinity"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    NasAgentClient._keepAlive = child;
    return child;
  }

  async checkPortReachable(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; socket.destroy(); resolve(ok); };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, host);
    });
  }

  /** MEASURED reachability + service state (SOW 24: never fabricate). */
  async health(host) {
    const [smbReachable, nfsReachable] = await Promise.all([this.checkPortReachable(host, 445), this.checkPortReachable(host, 2049)]);
    let services = { smbd: false, nfs: false };
    try { services = await this.call("services"); } catch { /* reachability alone still gives a verdict */ }
    return {
      smb: { reachable: smbReachable, serviceActive: !!services.smbd, port: 445 },
      nfs: { reachable: nfsReachable, serviceActive: !!services.nfs, port: 2049 },
      checkedAt: new Date().toISOString(),
      measurement: "MEASURED",
    };
  }

  // ---- shares ------------------------------------------------------------
  async createShare({ shareName, ownerUnixUser, recycleBin = true, backend = "dir", pool = null, spec = {} }) {
    const r = await this.call("share_apply", { backend, pool, spec: { name: shareName, owner: ownerUnixUser, recycle: { enabled: recycleBin }, ...spec } });
    return { dataPath: r.dataPath, confPath: r.confPath, backend: r.backend };
  }

  async applyShare({ spec, backend, pool }) {
    return this.call("share_apply", { spec, backend, pool });
  }

  async deleteShare({ shareName, purgeData = false }) {
    return this.call("share_delete", { name: shareName, purgeData });
  }

  async listRecycleBin({ shareName, unixUser }) {
    try {
      const { entries } = await this.call("recycle_list", { share: shareName });
      return entries.filter((e) => !unixUser || e.user === unixUser).map((e) => ({ path: e.path, recyclePath: e.recyclePath, originalPath: e.originalPath, user: e.user, sizeBytes: e.sizeBytes, deletedAt: e.deletedAt }));
    } catch {
      return [];
    }
  }

  // ---- users -------------------------------------------------------------
  async createUser({ username, password }) {
    return this.call("user_create", { username, password });
  }

  async disableUser({ username }) {
    return this.call("user_disable", { username });
  }

  // ---- file IO (bytes go through approved temp files, never argv/stdin) ---
  async readFile({ shareName, relativePath, snapshot }) {
    const tmp = path.join(os.tmpdir(), `inaya-nas-${randomUUID()}.bin`);
    await fs.writeFile(tmp, "");
    try {
      await this.call("get_file", { share: shareName, relPath: relativePath, dstPath: winPathToWslPath(tmp), snapshot }, { timeout: 120000 });
      return await fs.readFile(tmp);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  async writeFile({ shareName, relativePath, buffer, owner }) {
    const tmp = path.join(os.tmpdir(), `inaya-nas-${randomUUID()}.bin`);
    await fs.writeFile(tmp, buffer);
    try {
      return await this.call("put_file", { share: shareName, relPath: relativePath, srcPath: winPathToWslPath(tmp), owner }, { timeout: 120000 });
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  async listFiles({ shareName, limit }) {
    const r = await this.call("list_files", { share: shareName, limit }, { timeout: 120000 });
    return r.files;
  }

  async diskUsage(shareName) {
    return this.call("disk_usage", shareName ? { share: shareName } : {});
  }
}
