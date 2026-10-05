// src/acl.js -- reading the customer's own permissions for an approved folder.
//   Windows   `icacls <path>` (the operating system's own NTFS ACL reader). Allow and deny entries, inheritance and rights are preserved.
//   POSIX     owner/group/other mode bits. These are NOT a full ACL: they are reported with source "posix" so Inaya shows them as such.
// Names are reported as the OS resolves them (DOMAIN\user, BUILTIN\Administrators, S-1-5-... for an unresolved SID). Nothing is guessed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const RIGHT = { F: "full", M: "modify", RX: "read", R: "read", W: "write", D: "delete", RD: "read", REA: "read", RA: "read", RC: "read", WD: "write", AD: "write", WEA: "write", WA: "write", DC: "delete", X: null, S: null, N: null, GR: "read", GW: "write", GA: "full", GE: null };

/** Parses `icacls` output. Pure, so it is testable without a Windows machine. */
export function parseIcacls(text, targetPath = "") {
  const entries = []; const lines = String(text).split(/\r?\n/);
  for (let line of lines) {
    if (!line.trim() || /^Successfully processed|^Failed processing|^\s*$/.test(line.trim())) continue;
    if (targetPath && line.startsWith(targetPath)) line = line.slice(targetPath.length); // first line carries the path
    const m = /^\s*(.+?):((?:\([^)]*\))+)\s*$/.exec(line); if (!m) continue;
    const principal = m[1].trim(); const groups = [...m[2].matchAll(/\(([^)]*)\)/g)].map((g) => g[1].trim());
    let type = "allow", inherited = false; const rights = [];
    for (const g of groups) for (const tok of g.split(",").map((x) => x.trim())) {
      const u = tok.toUpperCase(); if (u === "DENY") type = "deny"; else if (u === "I") inherited = true; else if (["OI", "CI", "IO", "NP"].includes(u)) continue; else if (u in RIGHT) { if (RIGHT[u]) rights.push(RIGHT[u]); }
    }
    if (principal) entries.push({ principal, type, rights: [...new Set(rights)], inherited });
  }
  return entries;
}

export function readAcl(fullPath, { platform = process.platform, run = spawnSync } = {}) {
  if (platform === "win32") {
    const r = run("icacls", [fullPath], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (r.status !== 0) return { ok: false, source: "ntfs", error: String(r.stderr || r.stdout || "icacls failed").trim().slice(0, 200), entries: [] };
    return { ok: true, source: "ntfs", entries: parseIcacls(r.stdout, fullPath) };
  }
  try {
    const st = fs.statSync(fullPath); const bits = (n) => [n & 4 ? "read" : null, n & 2 ? "write" : null].filter(Boolean);
    return { ok: true, source: "posix", entries: [{ principal: `uid:${st.uid}`, type: "allow", rights: bits((st.mode >> 6) & 7), inherited: false }, { principal: `gid:${st.gid}`, type: "allow", rights: bits((st.mode >> 3) & 7), inherited: false }, { principal: "Everyone", type: "allow", rights: bits(st.mode & 7), inherited: false }].filter((e) => e.rights.length) };
  } catch (e) { return { ok: false, source: "posix", error: String(e.code || e.message), entries: [] }; }
}
