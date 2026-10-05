// src/connectors.js -- local data access. One implementation serves three connector types because the operating system does the protocol work:
//   filesystem  a local or already-mounted path
//   smb         a Windows UNC path (\\server\share) or a CIFS/SMB mount
//   nfs         an NFS mount (Linux/macOS)
// This agent does NOT speak SMB or NFS itself; it reads what the OS exposes. That keeps credentials with the OS and means "smb"/"nfs" work wherever the
// mount works. A connector reports `degraded` if its root cannot be read.
//
// Safety: every path is resolved under the approved folder; `..`, absolute escapes and symbolic links that leave the folder are skipped, never followed.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function resolveInside(root, rel) {
  const base = path.resolve(root); const full = path.resolve(base, ...String(rel || "").split("/").filter(Boolean));
  const relative = path.relative(base, full); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes the approved folder.");
  return full;
}
const within = (base, real) => { const r = path.relative(base, real); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

export const sha256File = (file) => new Promise((resolve, reject) => { const h = createHash("sha256"); fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex"))); });

/** Lists an approved folder (relative paths, forward slashes). Metadata only: name, size, mtime, directory flag, optional SHA-256 for small files. */
export async function scanFolder({ rootPath, folderPath, hashBelowBytes = 5 * 1024 * 1024, maxEntries = 20000, classify = null }) {
  const base = resolveInside(rootPath, folderPath); const realBase = fs.realpathSync(base); const out = []; let skipped = 0;
  const walk = async (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxEntries) return; const p = path.join(dir, d.name); const r = rel ? `${rel}/${d.name}` : d.name;
      let st; try { st = fs.lstatSync(p); } catch { skipped++; continue; }
      if (st.isSymbolicLink()) { let real; try { real = fs.realpathSync(p); } catch { skipped++; continue; } if (!within(realBase, real)) { skipped++; continue; } st = fs.statSync(p); }
      if (st.isDirectory()) { out.push({ path: r, size: 0, mtime: st.mtime.toISOString(), isDir: true }); await walk(p, r); }
      else if (st.isFile()) { const e = { path: r, size: st.size, mtime: st.mtime.toISOString(), isDir: false }; if (st.size <= hashBelowBytes) { try { e.sha256 = await sha256File(p); } catch { /* unreadable file: listed without a hash */ } } if (classify) { try { e.classification = classify(e) || undefined; } catch { /* a bad rule never stops a scan */ } } out.push(e); }
    }
  };
  await walk(realBase, ""); return { entries: out, skipped, truncated: out.length >= maxEntries };
}
export function connectorHealth({ rootPath }) { try { fs.accessSync(rootPath, fs.constants.R_OK); return { status: "ok", lastError: null }; } catch (e) { return { status: "error", lastError: String(e.code || e.message).slice(0, 120) }; } }
