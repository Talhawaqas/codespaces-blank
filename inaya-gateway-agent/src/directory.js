// src/directory.js -- the directory identities the agent can see, as principals with group memberships. Sources:
//   file          a JSON file the operator maintains or exports: [{ "principal": "CONTOSO\\alice", "kind": "user", "upn": "alice@contoso.com", "memberOf": ["CONTOSO\\finance"] }]
//   windows-local the machine's own local users and groups (PowerShell Get-LocalUser / Get-LocalGroupMember). No UPN exists for local accounts, so an
//                 administrator maps them in Inaya.
// A live LDAP / Active Directory source is NOT included in this agent. The separate ad-sync-agent already speaks LDAP to a domain controller; a directory
// source built on it would be added here, and has not been tested against a domain controller.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export function fromFile(file) { const j = JSON.parse(fs.readFileSync(file, "utf8")); return (Array.isArray(j) ? j : []).map((p) => ({ principal: String(p.principal), kind: p.kind === "group" ? "group" : "user", upn: p.upn || null, memberOf: Array.isArray(p.memberOf) ? p.memberOf.map(String) : [] })); }

export function windowsLocal({ run = spawnSync } = {}) {
  const ps = `$h=$env:COMPUTERNAME; $o=@(); Get-LocalUser | ForEach-Object { $o += [pscustomobject]@{principal="$h\\$($_.Name)";kind='user';upn=$null;memberOf=@()} }; Get-LocalGroup | ForEach-Object { $g=$_; $o += [pscustomobject]@{principal="$h\\$($g.Name)";kind='group';upn=$null;memberOf=@()}; try { Get-LocalGroupMember -Group $g.Name -ErrorAction Stop | ForEach-Object { $m=$_.Name; $o += [pscustomobject]@{principal=$m;kind='member';upn=$null;memberOf=@("$h\\$($g.Name)")} } } catch {} }; $o | ConvertTo-Json -Compress -Depth 4`;
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(String(r.stderr || "PowerShell failed").slice(0, 200));
  const arr = [].concat(JSON.parse(r.stdout || "[]")); const merged = new Map();
  for (const x of arr) { const key = String(x.principal).toLowerCase(); const cur = merged.get(key) || { principal: x.principal, kind: x.kind === "group" ? "group" : "user", upn: null, memberOf: [] }; if (x.kind === "group") cur.kind = "group"; for (const g of x.memberOf || []) if (!cur.memberOf.includes(g)) cur.memberOf.push(g); merged.set(key, cur); }
  return [...merged.values()];
}
export function load(source) { if (!source) return []; if (source.type === "file") return fromFile(source.path); if (source.type === "windows-local") return windowsLocal(); throw new Error(`Unknown directory source "${source.type}".`); }
