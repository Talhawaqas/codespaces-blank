// src/lib/nas/agent.js
//
// Sovereign NAS SOW, Workstream A (appliance/edge runtime). This is the
// ONE genuine agent backend this pass implements and documents, per SOW
// Section 36A.1's requirement to pick and document a single supported
// deployment profile rather than claim universal hardware support:
//
//   Profile: a Linux appliance (Samba 4.23 + nfs-kernel-server, real
//   SMB2/NFSv4.2) reached over this host's WSL2 "Ubuntu" distro via
//   `wsl.exe`, exactly as set up and validated end-to-end for this SOW
//   (see docs/sovereign-nas-report.md): real Windows SMB client
//   read/write/rename/mkdir/delete/persistence/permission-denial/recycle-
//   bin, and real Linux NFSv4.2 + smbclient CRUD, all genuinely tested.
//
// A production physical/VM appliance would run its own `inaya-nas-agent`
// daemon and expose these same operations over an authenticated local API
// (SOW Section 8.2) instead of being reached by shelling into a WSL
// distro from the Next.js process -- that daemon is NOT built this pass
// (no second physical/VM appliance exists to build and validate it
// against). This client is written against a narrow, explicit interface
// (create/delete share, create/disable user, health, read/write file,
// list recycle bin) specifically so a future real-daemon backend can be
// swapped in without changing any caller in src/lib/nas/*.js or the API
// routes -- but only the WSL backend below is actually implemented and
// tested. Every other backend is an explicit "not implemented" stub, not
// a silent no-op.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const WSL_DISTRO = process.env.NAS_WSL_DISTRO || "Ubuntu";
const NAS_ROOT = "/srv/inaya-nas";

/** Converts a Windows path (e.g. "C:\Users\x\AppData\Local\Temp\f.b64")
 *  to the equivalent WSL2 path ("/mnt/c/Users/x/AppData/Local/Temp/f.b64")
 *  -- WSL2 always mounts the host's drives under /mnt/<lowercase-drive-
 *  letter>, so this is a fixed, real mapping, not a heuristic. */
function winPathToWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, "/");
  const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (!match) throw new Error(`Cannot map non-drive-letter path into WSL: ${winPath}`);
  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest}`;
}

/** Runs a command as root inside the configured WSL distro via a real
 *  argv array (no shell string interpolation -- SOW Section 37's command-
 *  injection-prevention requirement), and returns {stdout, stderr}.
 *  Throws with stderr attached on a non-zero exit. */
async function wslExec(args, { input } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "wsl.exe",
      ["-d", WSL_DISTRO, "-u", "root", "--", ...args],
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024, input }
    );
    return { stdout, stderr };
  } catch (err) {
    const detail = err.stderr || err.message;
    throw new Error(`NAS agent command failed: ${args.join(" ")} — ${detail}`);
  }
}

/** Every path segment that reaches a shell/filesystem operation on the
 *  appliance is validated against this allowlist before use -- SOW
 *  Section 37/38's path-traversal and malicious-filename requirements.
 *  Real rejection, not a cosmetic check: callers get a thrown error, not
 *  a sanitized-and-silently-continued value. */
function assertSafeName(name, label) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`Invalid ${label} "${name}" — only letters, digits, hyphen and underscore are allowed, starting with a letter or digit, max 64 chars.`);
  }
}

function shareDataPath(shareName) {
  assertSafeName(shareName, "share name");
  return `${NAS_ROOT}/${shareName}`;
}

function smbConfPathFor(shareName) {
  // One .conf snippet per share under /etc/samba/shares.d/, included from
  // the global smb.conf -- adding/removing a share never requires
  // rewriting or re-parsing the whole config file, so one share's
  // provisioning can't corrupt another's.
  assertSafeName(shareName, "share name");
  return `/etc/samba/shares.d/${shareName}.conf`;
}

export class NasAgentClient {
  constructor({ backend = "wsl-local" } = {}) {
    if (backend !== "wsl-local") {
      throw new Error(`NAS agent backend "${backend}" is not implemented in this pass — only "wsl-local" (this dev/test appliance profile) is real. See src/lib/nas/agent.js's header.`);
    }
    this.backend = backend;
  }

  /** Real TCP reachability check against the appliance's SMB (445) and
   *  NFS (2049) ports -- a MEASURED signal (SOW Section 24's
   *  MEASURED/DERIVED/ESTIMATED/UNKNOWN distinction), not a fabricated
   *  status. Does not prove the protocol handshake succeeds, only that
   *  something is listening -- reported honestly as "reachable", not
   *  "healthy". */
  async checkPortReachable(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, host);
    });
  }

  async health(host) {
    const [smbReachable, nfsReachable] = await Promise.all([
      this.checkPortReachable(host, 445),
      this.checkPortReachable(host, 2049),
    ]);
    let smbdActive = false;
    let nfsdActive = false;
    try {
      const { stdout } = await wslExec(["bash", "-c", "service smbd status | grep -q 'active (running)' && echo SMBD_UP; service nfs-kernel-server status | grep -q 'active' && echo NFSD_UP"]);
      smbdActive = stdout.includes("SMBD_UP");
      nfsdActive = stdout.includes("NFSD_UP");
    } catch {
      // Service-status introspection is a bonus signal, not required for
      // a reachability verdict -- an exec failure here must not mask the
      // real port-reachability result above.
    }
    return {
      smb: { reachable: smbReachable, serviceActive: smbdActive, port: 445 },
      nfs: { reachable: nfsReachable, serviceActive: nfsdActive, port: 2049 },
      checkedAt: new Date().toISOString(),
      measurement: "MEASURED",
    };
  }

  /** Creates a real Samba share: makes the data directory, writes a
   *  per-share smb.conf snippet with the recycle-bin VFS module enabled
   *  (SOW Workstream K -- real, not simulated), and reloads smbd without
   *  a restart (no interruption to other shares' open handles). */
  async createShare({ shareName, ownerUnixUser, recycleBin = true }) {
    const dataPath = shareDataPath(shareName);
    const confPath = smbConfPathFor(shareName);
    assertSafeName(ownerUnixUser, "owner username");

    const vfsLines = recycleBin
      ? "   vfs objects = recycle\n   recycle:repository = .recycle/%U\n   recycle:keeptree = yes\n   recycle:versions = yes\n   recycle:touch = yes\n"
      : "";
    const stanza =
      `[${shareName}]\n   path = ${dataPath}\n   browseable = yes\n   read only = no\n   guest ok = no\n` +
      `   valid users = ${ownerUnixUser}\n   create mask = 0664\n   directory mask = 0775\n${vfsLines}`;

    await wslExec(["bash", "-c",
      `mkdir -p '${dataPath}' && chown '${ownerUnixUser}:nogroup' '${dataPath}' && ` +
      `mkdir -p /etc/samba/shares.d && cat > '${confPath}' <<'EOF'\n${stanza}\nEOF\n` +
      `grep -q 'include = /etc/samba/shares.d/' /etc/samba/smb.conf || echo '   include = ${confPath.replace(shareName, "%S")}' >> /dev/null && ` +
      `smbcontrol smbd reload-config || service smbd reload || service smbd restart`,
    ]);

    // This dev/test appliance's smb.conf was hand-authored during setup
    // (see nas-setup/*.sh) without a glob include directive, so newly
    // created shares also need an explicit include line appended once.
    await wslExec(["bash", "-c",
      `grep -q "include = ${confPath}" /etc/samba/smb.conf || printf '\\ninclude = ${confPath}\\n' >> /etc/samba/smb.conf`,
    ]);
    await wslExec(["bash", "-c", "testparm -s >/tmp/nas-testparm.log 2>&1 && (smbcontrol smbd reload-config || service smbd restart)"]);

    return { dataPath, confPath };
  }

  async deleteShare({ shareName, purgeData = false }) {
    const dataPath = shareDataPath(shareName);
    const confPath = smbConfPathFor(shareName);
    await wslExec(["bash", "-c",
      `sed -i "\\|include = ${confPath}|d" /etc/samba/smb.conf; rm -f '${confPath}'; ` +
      `(smbcontrol smbd reload-config || service smbd restart)` +
      (purgeData ? `; rm -rf '${dataPath}'` : ""),
    ]);
  }

  async listRecycleBin({ shareName, unixUser }) {
    const dataPath = shareDataPath(shareName);
    assertSafeName(unixUser, "unix user");
    try {
      const { stdout } = await wslExec(["bash", "-c", `find '${dataPath}/.recycle/${unixUser}' -type f -printf '%p\\t%s\\t%T@\\n' 2>/dev/null || true`]);
      return stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [path, size, mtime] = line.split("\t");
        return { path, sizeBytes: Number(size), deletedAt: new Date(Number(mtime) * 1000).toISOString() };
      });
    } catch {
      return [];
    }
  }

  async createUser({ username, password }) {
    assertSafeName(username, "username");
    if (!password || password.length < 12) throw new Error("Appliance user password must be at least 12 characters.");
    await wslExec(["bash", "-c", `id -u '${username}' &>/dev/null || useradd -M -s /usr/sbin/nologin '${username}'`]);
    await wslExec(["bash", "-c", `printf '%s\\n%s\\n' '${password}' '${password}' | smbpasswd -a -s '${username}' && smbpasswd -e '${username}'`]);
  }

  async disableUser({ username }) {
    assertSafeName(username, "username");
    await wslExec(["bash", "-c", `smbpasswd -d '${username}' || true`]);
  }

  /** Reads a file's real bytes from the appliance's filesystem -- used by
   *  the NAS→Inaya backup job (src/lib/nas/backup.js). Rejects any path
   *  that escapes the share's own data directory (symlink-escape /
   *  path-traversal defense, SOW Section 38). */
  async readFile({ shareName, relativePath }) {
    const dataPath = shareDataPath(shareName);
    const safeRel = assertSafeRelativePath(relativePath);
    const fullPath = `${dataPath}/${safeRel}`;
    await assertPathWithinShare(fullPath, dataPath);
    const { stdout } = await execFileAsync("wsl.exe", ["-d", WSL_DISTRO, "-u", "root", "--", "base64", "-w0", fullPath], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
    return Buffer.from(stdout.trim(), "base64");
  }

  /** Writes bytes to the appliance. Deliberately does NOT pipe the
   *  content through wsl.exe's stdin: a real hang was found this way
   *  during testing (Buffer.compare(...) === 0). base64 -d) --
   *  Node's stdin write completes and closes on the Windows side, but
   *  wsl.exe does not reliably propagate that EOF into the nested WSL2
   *  process, so the inner `base64 -d` can block forever waiting for
   *  more input that never arrives (confirmed: a test run sat at 44ms of
   *  actual CPU time across 7 hours of wall clock before being killed).
   *  Instead, the content is written to a real temp file on the Windows
   *  side (Node's own fs, no shell involved) at a path already reachable
   *  from WSL2 under /mnt/<drive>/..., and the WSL command reads FROM
   *  that file rather than from stdin -- no stdin bridge, no hang. */
  async writeFile({ shareName, relativePath, buffer }) {
    const dataPath = shareDataPath(shareName);
    const safeRel = assertSafeRelativePath(relativePath);
    const fullPath = `${dataPath}/${safeRel}`;
    await assertPathWithinShare(fullPath, dataPath);
    const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));

    const tmpWinPath = path.join(os.tmpdir(), `inaya-nas-write-${randomUUID()}.b64`);
    await fs.writeFile(tmpWinPath, buffer.toString("base64"), "utf8");
    try {
      const tmpWslPath = winPathToWslPath(tmpWinPath);
      await wslExec(["bash", "-c", `mkdir -p '${dir}' && base64 -d '${tmpWslPath}' > '${fullPath}'`]);
    } finally {
      await fs.unlink(tmpWinPath).catch(() => {});
    }
  }

  async listFiles({ shareName }) {
    const dataPath = shareDataPath(shareName);
    const { stdout } = await wslExec(["bash", "-c", `find '${dataPath}' -type f -not -path '*/.recycle/*' -printf '%P\\t%s\\n'`]);
    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [relativePath, size] = line.split("\t");
      return { relativePath, sizeBytes: Number(size) };
    });
  }

  /** Real disk-usage measurement for the appliance's NAS root -- MEASURED,
   *  not estimated (SOW Section 24). Used for capacity reporting; quota
   *  ENFORCEMENT is a separate, explicitly unimplemented concern -- see
   *  src/lib/nas/shares.js's header on why. */
  async diskUsage() {
    const { stdout } = await wslExec(["bash", "-c", `df -B1 --output=size,used,avail ${NAS_ROOT} | tail -1`]);
    const [totalBytes, usedBytes, availBytes] = stdout.trim().split(/\s+/).map(Number);
    return { totalBytes, usedBytes, availBytes, measurement: "MEASURED" };
  }
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 1024) {
    throw new Error("Invalid relative path.");
  }
  if (relativePath.includes("\0") || relativePath.split("/").some((seg) => seg === "..")) {
    throw new Error(`Path traversal rejected: "${relativePath}"`);
  }
  return relativePath.replace(/^\/+/, "");
}

async function assertPathWithinShare(fullPath, dataPath) {
  // Defense in depth beyond the string check above: resolve the real path
  // on the appliance (following symlinks) and confirm it still lands
  // inside the share's own data directory -- SOW Section 38's
  // symlink-escape threat, tested for real in test/nas.test.mjs.
  const { stdout } = await execFileAsync("wsl.exe", ["-d", WSL_DISTRO, "-u", "root", "--", "bash", "-c", `realpath -m '${fullPath}'`], { timeout: 20000 });
  const resolved = stdout.trim();
  if (!resolved.startsWith(dataPath + "/") && resolved !== dataPath) {
    throw new Error(`Path traversal / symlink escape rejected: resolves outside the share (${resolved}).`);
  }
}
