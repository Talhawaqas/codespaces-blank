// src/lib/support/scanner.js
//
// Malware and active-content screening for every file that enters support (SOW §22, §44). Two layers:
//
//   1. STATIC INSPECTION (always on, built in, no third party): the standard EICAR test signature; executable
//      headers hidden inside "documents"; archive inspection (executables inside, encrypted entries that cannot be
//      inspected, nested archives, path traversal, zip-bomb ratios and entry counts); Office macros (OOXML
//      vbaProject.bin, legacy OLE VBA streams and auto-run names); PDF active content (JavaScript, Launch,
//      embedded files, incl. #xx-obfuscated names); scripts or PHP hidden in images.
//   2. A REAL ANTIVIRUS ENGINE (optional, operator-configured, used IN ADDITION to layer 1):
//        - ClamAV daemon (CLAMAV_HOST / CLAMAV_PORT): the file is streamed to your own clamd, nothing leaves your network;
//        - Cloudmersive Virus Scan API (CLOUDMERSIVE_API_KEY): the file is sent to that third party for scanning.
//      Static inspection alone is NOT a substitute for signature-based antivirus; the stored scan record says exactly
//      which engines ran, and an organization can require an engine (settings.scan.mode = "engine_required"), in
//      which case files are refused when no engine can be reached (fail closed).
//
// Verdicts: CLEAN, INFECTED (engine detection or EICAR), SUSPICIOUS (active content / unsafe structure), ERROR
// (an engine was required or configured but could not give an answer). Anything other than CLEAN is refused.

import net from "node:net";
import { localTestHostsAllowed } from "../workflows/http.js";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EXEC_EXT = new Set(["exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "vbs", "vbe", "js", "jse", "jar", "app", "apk", "sh", "reg", "lnk", "hta", "cpl", "wsf", "pif", "iso", "php", "py", "rb", "pl", "msc", "gadget", "docm", "xlsm", "pptm", "dotm", "xlsb", "xlam"]);
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz", "cab", "z"]);
const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_RATIO = 150;

const ext = (n) => (String(n).split(".").length > 1 ? String(n).split(".").pop().toLowerCase() : "");
const has = (buf, needle, from = 0) => buf.indexOf(needle, from) !== -1;

// ------------------------------------------------------------------------------- zip inspection
function parseZip(buf) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return { error: "The archive is damaged or not a valid zip file." };
  const total = buf.readUInt16LE(eocd + 10); const cdSize = buf.readUInt32LE(eocd + 12); let off = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || off === 0xffffffff) return { error: "Zip64 archives are not accepted." };
  if (off + cdSize > buf.length) return { error: "The archive directory is damaged." };
  const entries = [];
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return { error: "The archive directory is damaged." };
    const flags = buf.readUInt16LE(off + 8); const csize = buf.readUInt32LE(off + 20); const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28); const elen = buf.readUInt16LE(off + 30); const clen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    entries.push({ name, encrypted: !!(flags & 1), csize, usize });
    off += 46 + nlen + elen + clen;
    if (entries.length > MAX_ENTRIES) return { error: `The archive has more than ${MAX_ENTRIES} entries.` };
  }
  return { entries };
}

function inspectZip(buf, { ooxml }) {
  const findings = [];
  const z = parseZip(buf);
  if (z.error) return [{ kind: "ARCHIVE_UNSAFE", detail: z.error }];
  let total = 0;
  for (const e of z.entries) {
    total += e.usize;
    const lower = e.name.toLowerCase();
    if (e.encrypted) findings.push({ kind: "ARCHIVE_ENCRYPTED", detail: `"${e.name}" is password-protected, so it cannot be inspected.` });
    if (/(^|[\\/])\.\.([\\/]|$)/.test(e.name) || /^([a-z]:)?[\\/]/i.test(e.name)) findings.push({ kind: "ARCHIVE_PATH_TRAVERSAL", detail: `"${e.name}" points outside the archive.` });
    if (e.csize > 0 && e.usize / e.csize > MAX_RATIO && e.usize > 1024 * 1024) findings.push({ kind: "ARCHIVE_BOMB", detail: `"${e.name}" expands ${Math.round(e.usize / e.csize)}x.` });
    const x = ext(lower);
    if (EXEC_EXT.has(x) && !(ooxml && x === "bin")) findings.push({ kind: "ARCHIVE_EXECUTABLE", detail: `"${e.name}" is an executable or script.` });
    else if (ARCHIVE_EXT.has(x)) findings.push({ kind: "ARCHIVE_NESTED", detail: `"${e.name}" is an archive inside an archive and cannot be inspected.` });
    if (ooxml && /vbaproject\.bin$/i.test(lower)) findings.push({ kind: "OFFICE_MACRO", detail: "The document contains VBA macros." });
    if (ooxml && /(^|\/)activex\//i.test(lower)) findings.push({ kind: "OFFICE_ACTIVEX", detail: "The document contains ActiveX controls." });
    if (ooxml && /(^|\/)embeddings\/.+\.(exe|dll|bat|js|vbs|scr|com|jar|lnk)$/i.test(lower)) findings.push({ kind: "OFFICE_EMBEDDED_EXECUTABLE", detail: `"${e.name}" is an embedded executable.` });
  }
  if (total > MAX_UNCOMPRESSED) findings.push({ kind: "ARCHIVE_BOMB", detail: `The archive expands to ${Math.round(total / 1048576)} MB.` });
  return findings;
}

// --------------------------------------------------------------------------------------- formats
function pdfNames(buf) {
  const raw = buf.toString("latin1");
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function staticScan(filename, buf) {
  const findings = [];
  const x = ext(filename);
  const head = buf.subarray(0, 8);
  if (has(buf, EICAR)) findings.push({ kind: "EICAR", detail: "The EICAR antivirus test signature was found.", verdict: "INFECTED" });
  const isMZ = head[0] === 0x4d && head[1] === 0x5a; const isELF = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  const isMachO = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcffaedfe, 0xcefaedfe].includes(buf.length >= 4 ? buf.readUInt32BE(0) : 0);
  if (isMZ || isELF || isMachO) findings.push({ kind: "EXECUTABLE_CONTENT", detail: "The file is an executable program." });
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head.equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));

  if (["docx", "xlsx", "pptx"].includes(x)) {
    if (!isZip) findings.push({ kind: "TYPE_MISMATCH", detail: `The file is named .${x} but is not an Office document.` });
    else findings.push(...inspectZip(buf, { ooxml: true }));
  } else if (x === "zip") {
    if (!isZip) findings.push({ kind: "TYPE_MISMATCH", detail: "The file is named .zip but is not a zip archive." });
    else findings.push(...inspectZip(buf, { ooxml: false }));
  } else if (isZip && !["docx", "xlsx", "pptx", "zip"].includes(x)) {
    findings.push({ kind: "TYPE_MISMATCH", detail: `A zip archive is disguised as .${x}.` });
  }

  if (["doc", "xls", "ppt"].includes(x)) {
    if (!isOle && !isZip) findings.push({ kind: "TYPE_MISMATCH", detail: `The file is named .${x} but is not an Office document.` });
    if (isOle) {
      const u = (s) => Buffer.from(s, "utf16le");
      if (has(buf, u("_VBA_PROJECT")) || has(buf, "Attribute VB_Name") || has(buf, u("Macros")) || /Auto_?Open|Document_Open|Workbook_Open|AutoExec/i.test(buf.toString("latin1")) || has(buf, u("Auto_Open")) || has(buf, u("AutoOpen"))) findings.push({ kind: "OFFICE_MACRO", detail: "The document contains VBA macros." });
    }
  }

  if (x === "pdf") {
    const t = pdfNames(buf);
    if (/\/(JavaScript|JS)\b/.test(t)) findings.push({ kind: "PDF_JAVASCRIPT", detail: "The PDF contains JavaScript." });
    if (/\/Launch\b/.test(t)) findings.push({ kind: "PDF_LAUNCH", detail: "The PDF can launch programs." });
    if (/\/EmbeddedFile\b/.test(t)) findings.push({ kind: "PDF_EMBEDDED_FILE", detail: "The PDF carries embedded files." });
    if (/\/(RichMedia|XFA)\b/.test(t)) findings.push({ kind: "PDF_ACTIVE_CONTENT", detail: "The PDF contains active content." });
  }

  if (["png", "jpg", "jpeg", "gif", "webp"].includes(x)) {
    const edge = Buffer.concat([buf.subarray(0, 65536), buf.subarray(Math.max(0, buf.length - 65536))]).toString("latin1");
    if (/<\?php|<script[\s>]|<svg[\s>]|<html[\s>]|onerror\s*=/i.test(edge)) findings.push({ kind: "IMAGE_POLYGLOT", detail: "The image has script or markup hidden inside it." });
  }
  if (["txt", "csv", "log", "json", "md"].includes(x)) {
    const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff); // a byte-order mark means legitimate UTF-16 text
    if (!utf16 && buf.subarray(0, 4096).includes(0)) findings.push({ kind: "TYPE_MISMATCH", detail: `The file is named .${x} but contains binary data.` });
  }
  return findings;
}

// ------------------------------------------------------------------------------------- engines
export function configuredEngines() {
  const out = [];
  if (process.env.CLAMAV_HOST) out.push("clamd");
  if (process.env.CLOUDMERSIVE_API_KEY) out.push("cloudmersive");
  return out;
}

function clamdScan(buf, { host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT) || 3310, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let out = ""; let done = false;
    const finish = (fn, v) => { if (done) return; done = true; sock.destroy(); fn(v); };
    sock.setTimeout(timeoutMs, () => finish(reject, new Error("ClamAV timed out.")));
    sock.on("error", (e) => finish(reject, new Error(`ClamAV unreachable: ${e.message}`)));
    sock.on("data", (d) => { out += d.toString("utf8"); });
    sock.on("end", () => {
      const line = out.replace(/\0/g, "").trim();
      if (/ FOUND$/.test(line)) finish(resolve, { clean: false, signature: line.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, "") });
      else if (/ OK$/.test(line) || line === "stream: OK") finish(resolve, { clean: true });
      else finish(reject, new Error(`ClamAV answered: ${line.slice(0, 120) || "nothing"}`));
    });
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      for (let i = 0; i < buf.length; i += 65536) { const chunk = buf.subarray(i, i + 65536); const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length); sock.write(len); sock.write(chunk); }
      sock.write(Buffer.alloc(4));
    });
  });
}

async function cloudmersiveScan(buf, filename, { timeoutMs = 45000 } = {}) {
  const base = String(process.env.CLOUDMERSIVE_BASE_URL || "https://api.cloudmersive.com").replace(/\/$/, "");
  if (!/^https:\/\//i.test(base) && !(localTestHostsAllowed() && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(base))) throw new Error("The scan service URL must be https.");
  const fd = new FormData();
  fd.append("inputFile", new Blob([buf]), filename || "file");
  const res = await fetch(`${base}/virus/scan/file`, { method: "POST", headers: { Apikey: process.env.CLOUDMERSIVE_API_KEY }, body: fd, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Cloudmersive answered ${res.status}.`);
  const j = await res.json().catch(() => null);
  if (!j || typeof j.CleanResult !== "boolean") throw new Error("Cloudmersive gave an unreadable answer.");
  return j.CleanResult ? { clean: true } : { clean: false, signature: (j.FoundViruses || []).map((v) => v.VirusName).filter(Boolean).join(", ") || "detected" };
}

/**
 * Scans one file. mode: "static" (built-in inspection, plus any configured engine) or "engine_required" (refuse when no
 * engine gave an answer). Returns { status, engines, findings, scannedAt }.
 */
export async function scanBuffer({ filename, buffer, mode = "static" }) {
  const findings = staticScan(filename, buffer);
  const engines = ["static"];
  const record = (status) => ({ status, engines, findings: findings.map(({ kind, detail }) => ({ kind, detail })), scannedAt: new Date().toISOString() });
  if (findings.some((f) => f.verdict === "INFECTED")) return record("INFECTED");
  let engineError = null; let engineAnswered = false;
  for (const name of configuredEngines()) {
    try {
      const r = name === "clamd" ? await clamdScan(buffer) : await cloudmersiveScan(buffer, filename);
      engines.push(name); engineAnswered = true;
      if (!r.clean) { findings.push({ kind: "ENGINE_DETECTION", detail: `${name} detected ${r.signature}.` }); return record("INFECTED"); }
    } catch (err) { engineError = `${name}: ${err.message}`; }
  }
  if (engineError) { findings.push({ kind: "ENGINE_ERROR", detail: engineError }); return record("ERROR"); } // a configured engine that cannot answer means the file is not proven clean
  if (mode === "engine_required" && !engineAnswered) { findings.push({ kind: "ENGINE_REQUIRED", detail: "This workspace requires an antivirus engine and none is configured." }); return record("ERROR"); }
  return record(findings.length ? "SUSPICIOUS" : "CLEAN");
}

/** The message shown to the person who uploaded a refused file (never the internal detail of an engine failure). */
export function scanRefusal(scan) {
  if (scan.status === "INFECTED") return "This file was blocked because it looks like malware.";
  if (scan.status === "SUSPICIOUS") return `This file was blocked: ${scan.findings[0]?.detail || "it contains active content."}`;
  return "This file could not be scanned right now, so it was not accepted. Please try again shortly.";
}

export const EICAR_TEST_STRING = EICAR;
