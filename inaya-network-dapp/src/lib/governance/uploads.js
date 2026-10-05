// src/lib/governance/uploads.js
//
// Upload governance (Competitive Expansion SOW, UPLOAD-001/002). One function, `governUpload`, that every upload path calls BEFORE it stores
// anything: extension and MIME rules, size, per-actor volume, content sniffing (the bytes must look like what the name says), archive
// inspection (zip bombs, nesting, encrypted members), a SHA-256 block list, then antivirus through the existing scanner
// (src/lib/support/scanner.js), and finally the org's DLP rules for the "upload" action.
//
// What it can and cannot see: when the caller has the bytes (S3/Azure API, server-side generators) every check runs. When content is
// end-to-end encrypted before it reaches Inaya (file requests, wallet and workspace uploads) only the metadata checks are possible; the
// result says `contentInspected: false` so nothing pretends a scan happened. Clean files are never recorded; refusals are.
// Policy comes from published `upload_types` governance policies (most restrictive value wins when several apply).

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { effectivePolicies } from "./policies.js";
import { enforceDlp } from "./dlp.js";
import { scanBuffer, scanRefusal } from "../support/scanner.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { ObjectId } from "mongodb";
import { emitFileEvent } from "./events.js";

export class UploadBlocked extends Error {
  constructor(result) { super(result.message); this.name = "UploadBlocked"; this.status = 403; this.code = result.code; this.decision = result.decision; this.result = result; }
}
const lower = (v) => String(v ?? "").toLowerCase();
const extOf = (name) => (String(name).includes(".") ? lower(String(name).split(".").pop()) : "");

/** Always-on: names that are never a legitimate upload regardless of org policy. */
export function checkFilename(name) {
  const n = String(name ?? "");
  if (!n || n.length > 1024) return "The file name is empty or too long.";
  if (/[\u0000-\u001f]/.test(n)) return "The file name contains control characters.";
  if (n.split(/[\\/]/).some((seg) => seg === ".." )) return "The file name contains a path traversal.";
  return null;
}

// ------------------------------------------------------------------------------------------------------ content sniffing
const MAGIC = [
  ["pdf", [0x25, 0x50, 0x44, 0x46]], ["png", [0x89, 0x50, 0x4e, 0x47]], ["jpg", [0xff, 0xd8, 0xff]], ["jpeg", [0xff, 0xd8, 0xff]], ["gif", [0x47, 0x49, 0x46, 0x38]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]], ["docx", [0x50, 0x4b, 0x03, 0x04]], ["xlsx", [0x50, 0x4b, 0x03, 0x04]], ["pptx", [0x50, 0x4b, 0x03, 0x04]],
  ["gz", [0x1f, 0x8b]], ["7z", [0x37, 0x7a, 0xbc, 0xaf]], ["rar", [0x52, 0x61, 0x72, 0x21]],
];
const EXECUTABLE_MAGIC = [[0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]]; // PE, ELF, Mach-O, fat/Java class
const startsWith = (buf, sig) => sig.every((b, i) => buf[i] === b);
/** An executable renamed to look like a document, or a document type whose signature is wrong. Returns a finding or null. */
export function sniffMismatch(filename, buf) {
  if (!buf || buf.length < 4) return null; const ext = extOf(filename);
  const isExe = EXECUTABLE_MAGIC.some((s) => startsWith(buf, s));
  if (isExe && !["exe", "dll", "so", "dylib", "bin", "class", "o", "com", "scr"].includes(ext)) return `The content is an executable program but the name says .${ext || "(none)"}.`;
  const want = MAGIC.find(([e]) => e === ext); if (want && !startsWith(buf, want[1])) return `The content does not look like a .${ext} file.`;
  return null;
}

// ------------------------------------------------------------------------------------------------------ archives
/** Reads a zip's central directory (no extraction to disk). Returns entry names/sizes and recurses into small nested zips. Bounded everywhere. */
export function inspectZip(buf, { maxDepth = 3, maxEntries = 5000, maxExpanded = 2 * 1024 ** 3, depth = 1, budget = { entries: 0, expanded: 0 } } = {}) {
  const out = { entries: 0, expanded: 0, compressed: buf.length, maxDepth: depth, encrypted: false, issues: [], names: [] };
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { out.issues.push("NOT_A_ZIP"); return out; }
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) { out.issues.push("TOO_MANY_ENTRIES"); out.entries = count; return out; }
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) { out.issues.push("DAMAGED_DIRECTORY"); break; }
    const flags = buf.readUInt16LE(off + 8), method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nl).toString("utf8");
    out.entries++; out.expanded += usize; budget.entries++; budget.expanded += usize; if (flags & 1) out.encrypted = true; if (out.names.length < 50) out.names.push(name);
    if (name.split(/[\\/]/).includes("..") || /^([\\/]|[a-zA-Z]:)/.test(name)) out.issues.push("PATH_TRAVERSAL_ENTRY");
    if (budget.entries > maxEntries) { out.issues.push("TOO_MANY_ENTRIES"); break; }
    if (budget.expanded > maxExpanded) { out.issues.push("EXPANDS_TOO_LARGE"); break; }
    if (/\.(zip|jar|docx|xlsx|pptx)$/i.test(name) && !(flags & 1) && csize > 0 && csize < 8 * 1024 * 1024) {
      if (depth >= maxDepth) { out.issues.push("TOO_DEEP"); } else {
        try {
          const lh = lho; const lnl = buf.readUInt16LE(lh + 26), lel = buf.readUInt16LE(lh + 28); const dataStart = lh + 30 + lnl + lel;
          const raw = buf.subarray(dataStart, dataStart + csize); const inner = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: 32 * 1024 * 1024 }) : null;
          if (inner && inner.readUInt32LE(0) === 0x04034b50) { const sub = inspectZip(inner, { maxDepth, maxEntries, maxExpanded, depth: depth + 1, budget }); out.maxDepth = Math.max(out.maxDepth, sub.maxDepth); out.encrypted ||= sub.encrypted; for (const i of sub.issues) if (!out.issues.includes(i)) out.issues.push(i); }
        } catch { out.issues.push("NESTED_UNREADABLE"); }
      }
    }
    off += 46 + nl + el + cl;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------- policy
const SCAN_ORDER = { none: 0, static: 1, engine_required: 2 };
/** Merge every applicable `upload_types` policy: the most restrictive value of each setting wins. */
export function mergeUploadPolicies(policies) {
  const m = { denyExtensions: new Set(), allowExtensions: null, maxBytes: Infinity, maxFilesPerHour: Infinity, blockedSha256: new Set(), requireScan: "none", enforceMime: false, inspectArchives: false, maxArchiveDepth: 3, maxArchiveEntries: 5000, maxArchiveRatio: 100, blockEncryptedArchives: false, sources: [] };
  for (const p of policies) {
    const c = p.config || {}; m.sources.push({ policyKey: p.policyKey, version: p.version });
    for (const e of c.denyExtensions || []) m.denyExtensions.add(lower(e).replace(/^\./, ""));
    if (Array.isArray(c.allowExtensions) && c.allowExtensions.length) { const s = new Set(c.allowExtensions.map((e) => lower(e).replace(/^\./, ""))); m.allowExtensions = m.allowExtensions ? new Set([...m.allowExtensions].filter((x) => s.has(x))) : s; }
    if (c.maxBytes != null) m.maxBytes = Math.min(m.maxBytes, c.maxBytes); if (c.maxFilesPerHour != null) m.maxFilesPerHour = Math.min(m.maxFilesPerHour, c.maxFilesPerHour);
    for (const h of c.blockedSha256 || []) m.blockedSha256.add(lower(h));
    if (SCAN_ORDER[c.requireScan] > SCAN_ORDER[m.requireScan]) m.requireScan = c.requireScan;
    m.enforceMime ||= !!c.enforceMime; m.inspectArchives ||= !!c.inspectArchives; m.blockEncryptedArchives ||= !!c.blockEncryptedArchives;
    if (c.maxArchiveDepth != null) m.maxArchiveDepth = Math.min(m.maxArchiveDepth, c.maxArchiveDepth); if (c.maxArchiveEntries != null) m.maxArchiveEntries = Math.min(m.maxArchiveEntries, c.maxArchiveEntries); if (c.maxArchiveRatio != null) m.maxArchiveRatio = Math.min(m.maxArchiveRatio, c.maxArchiveRatio);
  }
  return m;
}

let eventsIndexed = false;
async function eventsCol() { const c = await getOrgCollections(); const e = c.db.collection("dlp_events"); if (!eventsIndexed) { await e.createIndex({ orgId: 1, at: -1 }); eventsIndexed = true; } return e; }
async function recordRefusal({ orgId, actorEmail, source, filename, size, decision, code, reasons, ip }) {
  emitFileEvent(orgId, "upload_blocked", { source, code, decision, filename: String(filename).slice(0, 200) });
  try { await (await eventsCol()).insertOne({ _id: new ObjectId(), orgId: toObjectId(orgId), at: new Date().toISOString(), kind: "upload", actorEmail: lower(actorEmail), action: "upload", resourceType: "upload", resourceId: null, path: String(filename).slice(0, 300), decision, ruleId: code, ruleName: "Upload governance", policyKey: null, policyVersion: null, reason: reasons[0]?.detail || code, matchedOn: reasons.map((r) => r.code), enforced: true, context: { source, size, fileType: extOf(filename) || null, ip: ip ? String(ip).replace(/\.\d+$/, ".0") : null } }); } catch { /* never block on logging */ }
}

/**
 * Check one upload. `bytes` may be omitted when the content is not visible to the server.
 * Returns { allowed, decision, code, message, reasons, contentInspected, scan } and never throws for a refusal; use `assertUpload` to throw.
 */
export async function governUpload({ orgId, actorEmail, source = "api", filename, size, contentType = null, bytes = null, ip = null, path = null, departmentId = null, role = null, classification = null, runDlp = true }) {
  const reasons = []; const contentInspected = !!bytes; let scan = null; let decision = "ALLOW"; let code = null;
  const refuse = (c, detail, d = "DENY") => { reasons.push({ code: c, detail }); if (decision === "ALLOW") { decision = d; code = c; } };
  const bad = checkFilename(filename); if (bad) refuse("BAD_FILENAME", bad);
  const ext = extOf(filename);
  const policies = await effectivePolicies({ orgId, type: "upload_types", ctx: { email: actorEmail, role, departmentId, path: path ?? filename } });
  const m = mergeUploadPolicies(policies);
  if (m.denyExtensions.has(ext)) refuse("EXTENSION_BLOCKED", `Files of type .${ext} are not allowed by your organization.`);
  if (m.allowExtensions && !m.allowExtensions.has(ext)) refuse("EXTENSION_NOT_ALLOWED", `Only these file types are allowed: ${[...m.allowExtensions].join(", ")}.`);
  const n = bytes ? bytes.length : Number(size) || 0;
  if (n > m.maxBytes) refuse("TOO_LARGE", `The file is larger than the allowed ${Math.round(m.maxBytes / 1048576)} MB.`);
  if (m.maxFilesPerHour !== Infinity) { const rl = await slidingWindowCheck({ action: "upload:vol", key: `${orgId}:${lower(actorEmail)}`, max: m.maxFilesPerHour, windowMs: 3600_000 }); if (!rl.allowed) refuse("RATE_LIMITED", "Too many files in the last hour."); }
  if (bytes && decision === "ALLOW") {
    const mm = m.enforceMime ? sniffMismatch(filename, bytes) : null; if (mm) refuse("TYPE_MISMATCH", mm);
    if (m.blockedSha256.size && m.blockedSha256.has(createHash("sha256").update(bytes).digest("hex"))) refuse("BLOCKED_HASH", "This exact file is on your organization's block list.");
    if (m.inspectArchives && bytes.length >= 22 && (ext === "zip" || bytes.readUInt32LE(0) === 0x04034b50)) {
      const z = inspectZip(bytes, { maxDepth: m.maxArchiveDepth, maxEntries: m.maxArchiveEntries });
      const ratio = z.compressed ? z.expanded / z.compressed : 0;
      if (z.issues.includes("TOO_MANY_ENTRIES")) refuse("ARCHIVE_TOO_MANY_FILES", "The archive contains too many files.");
      else if (z.issues.includes("EXPANDS_TOO_LARGE") || ratio > m.maxArchiveRatio) refuse("ARCHIVE_BOMB", "The archive expands to an unreasonable size.");
      else if (z.issues.includes("TOO_DEEP")) refuse("ARCHIVE_TOO_DEEP", "The archive contains archives nested too deeply.");
      else if (z.issues.includes("PATH_TRAVERSAL_ENTRY")) refuse("ARCHIVE_UNSAFE_PATH", "The archive contains an unsafe file path.");
      else if (z.encrypted && m.blockEncryptedArchives) refuse("ARCHIVE_ENCRYPTED", "Password-protected archives cannot be inspected and are not allowed.");
    }
    if (decision === "ALLOW" && m.requireScan !== "none") {
      scan = await scanBuffer({ filename, buffer: bytes, mode: m.requireScan });
      if (scan.status === "INFECTED") refuse("MALWARE", scanRefusal(scan), "QUARANTINE");
      else if (scan.status === "SUSPICIOUS" || scan.status === "ERROR") refuse("SCAN_REFUSED", scanRefusal(scan));
    }
  }
  if (decision === "ALLOW" && runDlp) {
    const d = await enforceDlp({ orgId, ctx: { email: actorEmail, role, departmentId, ip, action: "upload", filename, path: path ?? filename, size: n, contentType, classification, source, resourceType: "upload", destinationType: "internal" } });
    if (!d.allowed) { decision = d.decision === "QUARANTINE" ? "QUARANTINE" : "DENY"; code = d.code; reasons.push({ code: d.code, detail: d.message }); return { allowed: false, decision, code, message: d.message, reasons, contentInspected, scan, approvalId: d.approvalId, eventId: d.eventId }; }
  } else if (decision !== "ALLOW") await recordRefusal({ orgId, actorEmail, source, filename, size: n, decision, code, reasons, ip });
  const message = decision === "ALLOW" ? null : reasons[0].detail;
  return { allowed: decision === "ALLOW", decision, code, message, reasons, contentInspected, scan };
}
export async function assertUpload(args) { const r = await governUpload(args); if (!r.allowed) throw new UploadBlocked(r); return r; }
