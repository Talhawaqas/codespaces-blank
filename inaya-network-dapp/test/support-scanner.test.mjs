// test/support-scanner.test.mjs -- malware and active-content screening (no database).
// Built-in static inspection is exercised with real crafted files; the antivirus-engine adapters are exercised against
// local servers that speak the real protocols (clamd INSTREAM, Cloudmersive REST). No real engine is involved.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { deflateRawSync, crc32 } from "node:zlib";
import { scanBuffer, configuredEngines, EICAR_TEST_STRING, scanRefusal } from "../src/lib/support/scanner.js";
import { screenFile, preflightFile } from "../src/lib/support/attachments.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// a tiny zip writer (store/deflate) so tests can craft archives with exactly the properties they need
function zip(entries) {
  const locals = []; const central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const data = Buffer.from(e.data ?? ""); const comp = e.store === false ? deflateRawSync(data) : data;
    const method = e.store === false ? 8 : 0; const crc = crc32(data) >>> 0; const flags = e.encrypted ? 1 : 0;
    const usize = e.fakeUsize ?? data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);
const kinds = (r) => r.findings.map((f) => f.kind);

before(() => { for (const k of ["CLAMAV_HOST", "CLAMAV_PORT", "CLOUDMERSIVE_API_KEY", "CLOUDMERSIVE_BASE_URL"]) delete process.env[k]; });
after(async () => { delete process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL; try { (await mongoClientPromise).close(); } catch { /* not connected */ } });

test("clean files pass; the report says which layers ran", async () => {
  const png = await scanBuffer({ filename: "a.png", buffer: PNG });
  assert.equal(png.status, "CLEAN"); assert.deepEqual(png.engines, ["static"]);
  assert.equal((await scanBuffer({ filename: "notes.txt", buffer: Buffer.from("hello world\nsecond line") })).status, "CLEAN");
  assert.equal((await scanBuffer({ filename: "ok.pdf", buffer: Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF") })).status, "CLEAN");
  assert.equal((await scanBuffer({ filename: "ok.zip", buffer: zip([{ name: "readme.txt", data: "hi" }, { name: "docs/a.png", data: PNG }]) })).status, "CLEAN");
  assert.equal((await scanBuffer({ filename: "d.docx", buffer: zip([{ name: "[Content_Types].xml", data: "<x/>" }, { name: "word/document.xml", data: "<w/>" }]) })).status, "CLEAN");
});

test("the EICAR test signature is detected, also when renamed", async () => {
  for (const name of ["virus.txt", "invoice.pdf", "photo.png", "x.csv"]) { const r = await scanBuffer({ filename: name, buffer: Buffer.from(`prefix ${EICAR_TEST_STRING} suffix`) }); assert.equal(r.status, "INFECTED", name); assert.ok(kinds(r).includes("EICAR")); }
  assert.match(scanRefusal(await scanBuffer({ filename: "v.txt", buffer: Buffer.from(EICAR_TEST_STRING) })), /malware/i);
});

test("archives: executables, encrypted entries, nested archives, traversal and bombs are refused", async () => {
  assert.ok(kinds(await scanBuffer({ filename: "a.zip", buffer: zip([{ name: "setup.exe", data: "MZ" }]) })).includes("ARCHIVE_EXECUTABLE"));
  assert.ok(kinds(await scanBuffer({ filename: "a.zip", buffer: zip([{ name: "run.js", data: "x" }]) })).includes("ARCHIVE_EXECUTABLE"));
  assert.ok(kinds(await scanBuffer({ filename: "a.zip", buffer: zip([{ name: "secret.txt", data: "x", encrypted: true }]) })).includes("ARCHIVE_ENCRYPTED"));
  assert.ok(kinds(await scanBuffer({ filename: "a.zip", buffer: zip([{ name: "inner.zip", data: "PK" }]) })).includes("ARCHIVE_NESTED"));
  assert.ok(kinds(await scanBuffer({ filename: "a.zip", buffer: zip([{ name: "../../etc/passwd", data: "x" }]) })).includes("ARCHIVE_PATH_TRAVERSAL"));
  assert.ok(kinds(await scanBuffer({ filename: "a.zip", buffer: zip([{ name: "C:/Windows/x.txt", data: "x" }]) })).includes("ARCHIVE_PATH_TRAVERSAL"));
  const bomb = await scanBuffer({ filename: "b.zip", buffer: zip([{ name: "zeros.txt", data: Buffer.alloc(1000, 0), store: false, fakeUsize: 900 * 1024 * 1024 }]) });
  assert.ok(kinds(bomb).includes("ARCHIVE_BOMB"));
  assert.equal((await scanBuffer({ filename: "broken.zip", buffer: Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100, 7)]) })).status, "SUSPICIOUS");
  const many = zip(Array.from({ length: 2100 }, (_, i) => ({ name: `f${i}.txt`, data: "a" })));
  assert.equal((await scanBuffer({ filename: "many.zip", buffer: many })).status, "SUSPICIOUS", "too many entries");
});

test("Office files: macros (modern and legacy), ActiveX and embedded executables are refused; spoofed types too", async () => {
  const base = [{ name: "[Content_Types].xml", data: "<x/>" }];
  assert.ok(kinds(await scanBuffer({ filename: "d.docx", buffer: zip([...base, { name: "word/vbaProject.bin", data: "x" }]) })).includes("OFFICE_MACRO"));
  assert.ok(kinds(await scanBuffer({ filename: "d.xlsx", buffer: zip([...base, { name: "xl/activeX/activeX1.xml", data: "x" }]) })).includes("OFFICE_ACTIVEX"));
  assert.ok(kinds(await scanBuffer({ filename: "d.pptx", buffer: zip([...base, { name: "ppt/embeddings/oleObject1.exe", data: "x" }]) })).some((k) => /OFFICE_EMBEDDED|ARCHIVE_EXECUTABLE/.test(k)));
  const ole = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.from("_VBA_PROJECT", "utf16le"), Buffer.alloc(100)]);
  assert.ok(kinds(await scanBuffer({ filename: "old.doc", buffer: ole })).includes("OFFICE_MACRO"));
  assert.equal((await scanBuffer({ filename: "old.xls", buffer: Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(200, 3)]) })).status, "CLEAN", "an OLE file without macros is fine");
  assert.ok(kinds(await scanBuffer({ filename: "fake.docx", buffer: Buffer.from("just text") })).includes("TYPE_MISMATCH"));
  assert.ok(kinds(await scanBuffer({ filename: "fake.png", buffer: zip([{ name: "a.txt", data: "x" }]) })).includes("TYPE_MISMATCH"), "a zip named .png");
});

test("PDFs: JavaScript, Launch and embedded files are refused, including obfuscated names", async () => {
  const pdf = (body) => Buffer.from(`%PDF-1.7\n${body}\n%%EOF`);
  assert.ok(kinds(await scanBuffer({ filename: "a.pdf", buffer: pdf("1 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj") })).includes("PDF_JAVASCRIPT"));
  assert.ok(kinds(await scanBuffer({ filename: "a.pdf", buffer: pdf("1 0 obj<</S/#4Aava#53cript>>endobj") })).includes("PDF_JAVASCRIPT"), "hex-escaped name");
  assert.ok(kinds(await scanBuffer({ filename: "a.pdf", buffer: pdf("1 0 obj<</S/Launch/F(cmd.exe)>>endobj") })).includes("PDF_LAUNCH"));
  assert.ok(kinds(await scanBuffer({ filename: "a.pdf", buffer: pdf("1 0 obj<</Type/EmbeddedFile>>endobj") })).includes("PDF_EMBEDDED_FILE"));
});

test("images and text: hidden scripts, executables and binary data are refused", async () => {
  assert.ok(kinds(await scanBuffer({ filename: "p.png", buffer: Buffer.concat([PNG, Buffer.from("<script>alert(1)</script>")]) })).includes("IMAGE_POLYGLOT"));
  assert.ok(kinds(await scanBuffer({ filename: "p.png", buffer: Buffer.concat([PNG, Buffer.from("<?php system($_GET[0]); ?>")]) })).includes("IMAGE_POLYGLOT"));
  assert.ok(kinds(await scanBuffer({ filename: "p.jpg", buffer: Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("<svg onload=x>")]) })).includes("IMAGE_POLYGLOT"));
  assert.ok(kinds(await scanBuffer({ filename: "n.txt", buffer: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]) })).includes("EXECUTABLE_CONTENT"));
  assert.ok(kinds(await scanBuffer({ filename: "n.txt", buffer: Buffer.from("7f454c46", "hex") })).includes("EXECUTABLE_CONTENT"), "ELF");
  assert.ok(kinds(await scanBuffer({ filename: "n.csv", buffer: Buffer.from("a,b\n\u0000\u0001\u0002binary") })).includes("TYPE_MISMATCH"));
});

test("screenFile applies name policy first, then the scan; preflight refuses before any bytes move", async () => {
  const settings = { attachments: { maxBytes: 1024 * 1024 }, scan: { mode: "static" } };
  assert.match((await screenFile({ filename: "x.exe", buffer: PNG, settings })).error, /not accepted/);
  const r = await screenFile({ filename: "v.txt", buffer: Buffer.from(EICAR_TEST_STRING), settings });
  assert.equal(r.reasonCode, "MALWARE_DETECTED"); assert.equal(r.scan.status, "INFECTED");
  assert.equal((await screenFile({ filename: "ok.png", buffer: PNG, settings })).scan.status, "CLEAN");
  assert.match(preflightFile({ filename: "a.exe", size: 10, settings }).error, /not accepted/);
  assert.match(preflightFile({ filename: "a.png", size: 5 * 1024 * 1024, settings }).error, /larger/);
  assert.match(preflightFile({ filename: "a.png", size: 0, settings }).error, /empty/);
  assert.equal(preflightFile({ filename: "../../a.png", size: 100, settings }).name, "a.png");
});

// ---------------------------------------------------------------- engines (real protocols, local servers)
function fakeClamd(verdict) {
  const seen = { bytes: 0, command: "" };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0); let started = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) { const z = buf.indexOf(0); if (z < 0) return; seen.command = buf.subarray(0, z).toString(); buf = buf.subarray(z + 1); started = true; }
      while (buf.length >= 4) { const len = buf.readUInt32BE(0); if (len === 0) { sock.end(verdict === "clean" ? "stream: OK\0" : verdict === "found" ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "INSTREAM size limit exceeded. ERROR\0"); return; } if (buf.length < 4 + len) return; seen.bytes += len; buf = buf.subarray(4 + len); }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, seen })));
}

test("ClamAV daemon adapter: streams the file with the real INSTREAM protocol and honours the verdict", async () => {
  const data = Buffer.from("x".repeat(200000));
  const ok = await fakeClamd("clean"); process.env.CLAMAV_HOST = "127.0.0.1"; process.env.CLAMAV_PORT = String(ok.port);
  assert.deepEqual(configuredEngines(), ["clamd"]);
  const r1 = await scanBuffer({ filename: "a.txt", buffer: data });
  assert.equal(r1.status, "CLEAN"); assert.deepEqual(r1.engines, ["static", "clamd"]);
  assert.equal(ok.seen.command, "zINSTREAM"); assert.equal(ok.seen.bytes, data.length, "every byte was streamed");
  ok.server.close();
  const bad = await fakeClamd("found"); process.env.CLAMAV_PORT = String(bad.port);
  const r2 = await scanBuffer({ filename: "a.txt", buffer: data });
  assert.equal(r2.status, "INFECTED"); assert.match(r2.findings.at(-1).detail, /EICAR_HDB/); bad.server.close();
  const err = await fakeClamd("error"); process.env.CLAMAV_PORT = String(err.port);
  assert.equal((await scanBuffer({ filename: "a.txt", buffer: data })).status, "ERROR", "an engine that answers with an error means the file is not proven clean"); err.server.close();
  process.env.CLAMAV_PORT = "1"; // nothing listens
  assert.equal((await scanBuffer({ filename: "a.txt", buffer: data })).status, "ERROR", "an unreachable configured engine fails closed");
  delete process.env.CLAMAV_HOST; delete process.env.CLAMAV_PORT;
});

test("Cloudmersive adapter: uploads over REST and honours CleanResult", async () => {
  process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1";
  let mode = "clean"; const seen = [];
  const srv = http.createServer((req, res) => { let n = 0; req.on("data", (d) => (n += d.length)); req.on("end", () => { seen.push({ url: req.url, key: req.headers.apikey, ct: req.headers["content-type"], n }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(mode === "clean" ? { CleanResult: true, FoundViruses: null } : mode === "bad" ? { CleanResult: false, FoundViruses: [{ FileName: "a.txt", VirusName: "Trojan.Test" }] } : { unexpected: 1 })); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.CLOUDMERSIVE_BASE_URL = `http://127.0.0.1:${srv.address().port}`; process.env.CLOUDMERSIVE_API_KEY = "test-key";
  assert.deepEqual(configuredEngines(), ["cloudmersive"]);
  const ok = await scanBuffer({ filename: "a.txt", buffer: Buffer.from("hello") });
  assert.equal(ok.status, "CLEAN"); assert.deepEqual(ok.engines, ["static", "cloudmersive"]);
  assert.equal(seen[0].url, "/virus/scan/file"); assert.equal(seen[0].key, "test-key"); assert.match(seen[0].ct, /multipart\/form-data/);
  mode = "bad"; const bad = await scanBuffer({ filename: "a.txt", buffer: Buffer.from("hello") });
  assert.equal(bad.status, "INFECTED"); assert.match(bad.findings.at(-1).detail, /Trojan\.Test/);
  mode = "garbage"; assert.equal((await scanBuffer({ filename: "a.txt", buffer: Buffer.from("hello") })).status, "ERROR");
  delete process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL;
  assert.equal((await scanBuffer({ filename: "a.txt", buffer: Buffer.from("hello") })).status, "ERROR", "a non-https scan URL is refused outside test mode");
  srv.close(); delete process.env.CLOUDMERSIVE_API_KEY; delete process.env.CLOUDMERSIVE_BASE_URL;
});

test("strict mode refuses files when no engine is configured; static mode accepts", async () => {
  assert.deepEqual(configuredEngines(), []);
  const strict = await scanBuffer({ filename: "a.png", buffer: PNG, mode: "engine_required" });
  assert.equal(strict.status, "ERROR"); assert.ok(kinds(strict).includes("ENGINE_REQUIRED"));
  assert.match(scanRefusal(strict), /could not be scanned/);
  assert.equal((await scanBuffer({ filename: "a.png", buffer: PNG, mode: "static" })).status, "CLEAN");
});
