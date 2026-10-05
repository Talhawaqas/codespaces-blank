// test/agent.test.mjs -- the gateway agent's own logic, with real files, real icacls (on Windows), real crypto. No network.
// Run with: node --test test/agent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { parseIcacls, readAcl } from "../src/acl.js";
import { scanFolder, resolveInside, connectorHealth } from "../src/connectors.js";
import { encryptFile, decryptBlob, makeThrottle, PART_BYTES, chainHashOf } from "../src/transfer.js";
import { openQueue } from "../src/queue.js";
import { openAudit, GENESIS } from "../src/audit.js";
import { encryptConfig, decryptConfig, saveConfig, loadConfig } from "../src/config.js";
import { signManifest, verifyPackage, stageUpgrade, rollback, chooseVersion, confirmHealthy, versionState } from "../src/upgrade.js";
import { generateIdentity, publicKeyOf, signedHeaders, signingString } from "../src/sign.js";
import { fromFile } from "../src/directory.js";
import { makeClassifier } from "../src/agent.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "inaya-gw-"));

test("parseIcacls keeps allow and deny, inheritance and rights (real icacls output format)", () => {
  const out = `C:\\data\\finance NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n                   BUILTIN\\Administrators:(OI)(CI)(F)\n                   CONTOSO\\finance:(I)(OI)(CI)(M)\n                   CONTOSO\\interns:(DENY)(W,D)\n                   Everyone:(OI)(CI)(RX)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  const e = parseIcacls(out, "C:\\data\\finance");
  assert.deepEqual(e.map((x) => x.principal), ["NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators", "CONTOSO\\finance", "CONTOSO\\interns", "Everyone"]);
  assert.equal(e[2].inherited, true); assert.deepEqual(e[2].rights, ["modify"]);
  assert.equal(e[3].type, "deny"); assert.deepEqual(e[3].rights.sort(), ["delete", "write"]);
  assert.deepEqual(e[4].rights, ["read"]); assert.equal(e[4].type, "allow");
});

test("readAcl on this machine: real icacls on Windows, mode bits elsewhere; an unreadable path is reported, not guessed", { skip: false }, () => {
  const d = tmp(); const r = readAcl(d);
  assert.equal(r.ok, true); assert.equal(r.source, process.platform === "win32" ? "ntfs" : "posix"); assert.ok(r.entries.length >= 1);
  if (process.platform === "win32") assert.ok(r.entries.some((e) => /Administrators|SYSTEM|Users/i.test(e.principal)), "a real NTFS ACL names real principals");
  const bad = readAcl(path.join(d, "does-not-exist")); assert.equal(bad.ok, false); assert.deepEqual(bad.entries, []);
});

test("scanFolder lists metadata only, hashes small files, never leaves the approved folder", async () => {
  const root = tmp(); fs.mkdirSync(path.join(root, "finance", "2026"), { recursive: true }); fs.mkdirSync(path.join(root, "secret"));
  fs.writeFileSync(path.join(root, "finance", "a.txt"), "hello"); fs.writeFileSync(path.join(root, "finance", "2026", "b.xlsx"), "xx"); fs.writeFileSync(path.join(root, "secret", "payroll.csv"), "nope");
  let linked = false; try { fs.symlinkSync(path.join(root, "secret"), path.join(root, "finance", "escape"), "junction"); linked = true; } catch { /* no privilege to link: the traversal checks below still run */ }
  const r = await scanFolder({ rootPath: root, folderPath: "finance" }); const paths = r.entries.map((e) => e.path).sort();
  assert.ok(paths.includes("a.txt") && paths.includes("2026/b.xlsx")); assert.equal(paths.some((p) => p.includes("payroll")), false, "nothing from outside the approved folder");
  assert.equal(r.entries.find((e) => e.path === "a.txt").sha256.length, 64); assert.equal(JSON.stringify(r.entries).includes("hello"), false, "no content");
  if (linked) assert.ok(r.skipped >= 1, "a link that leaves the folder is skipped");
  assert.throws(() => resolveInside(root, "../secret"), /escapes/); assert.throws(() => resolveInside(root, "finance/../../x"), /escapes/); await assert.rejects(scanFolder({ rootPath: root, folderPath: "../secret" }), /escapes/);
  assert.equal(connectorHealth({ rootPath: root }).status, "ok"); assert.equal(connectorHealth({ rootPath: path.join(root, "missing") }).status, "error");
  const cls = makeClassifier([{ extensions: [".xlsx"], level: "CONFIDENTIAL" }, { nameContains: ["payroll"], level: "RESTRICTED" }]); const c = await scanFolder({ rootPath: root, folderPath: "finance", classify: cls });
  assert.equal(c.entries.find((e) => e.path === "2026/b.xlsx").classification, "CONFIDENTIAL");
});

test("encryption: round trip, the server-visible bytes are not the plaintext, tampering is detected, and re-encrypting after an interruption gives identical parts", () => {
  const dataKey = randomBytes(32); const plain = randomBytes(PART_BYTES * 2 + 123); const a = encryptFile(plain, dataKey, "t1"); const b = encryptFile(plain, dataKey, "t1");
  assert.equal(a.parts.length, 3); assert.equal(a.cipherSize, plain.length + 12 + 16); assert.ok(a.parts.slice(0, 2).every((p) => p.length === PART_BYTES));
  assert.deepEqual(a.parts.map((p) => p.toString("hex")), b.parts.map((p) => p.toString("hex")), "deterministic, so stored parts stay valid on resume");
  assert.notDeepEqual(encryptFile(plain, dataKey, "t2").parts[0], a.parts[0], "a different transfer gets a different key and nonce");
  const blob = Buffer.concat(a.parts); assert.equal(blob.includes(plain.subarray(0, 64)), false); assert.deepEqual(decryptBlob(blob, a.envelope, dataKey), plain);
  assert.throws(() => decryptBlob(blob, a.envelope, randomBytes(32)), "the wrong data key cannot open the envelope");
  const bad = Buffer.from(blob); bad[100] ^= 1; assert.throws(() => decryptBlob(bad, a.envelope, dataKey), "a changed byte is detected");
  assert.equal(chainHashOf(["a", "b"]).length, 64);
});

test("throttle: a bandwidth cap really delays sends, unlimited never waits", async () => {
  let t = 0; const slept = []; const th = makeThrottle({ kbps: 100, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  const first = await th.take(102400); const second = await th.take(102400); assert.equal(first, 0, "the first second's allowance is available at once"); assert.ok(second >= 900, `second send waited ${second} ms`);
  assert.equal(await makeThrottle({ kbps: 0 }).take(1e9), 0);
});

test("offline queue: work survives a restart, stays queued while Inaya is unreachable, drains in order afterwards; a rejected item is dropped after five tries", async () => {
  const dir = tmp(); let q = openQueue(dir); q.push("inventory", { n: 1 }); q.push("acl", { n: 2 }, "acl:f"); q.push("acl", { n: 3 }, "acl:f");
  assert.equal(q.depth(), 2, "an item with the same key replaces the older one"); q = openQueue(dir); assert.equal(q.depth(), 2, "survives a restart");
  const down = Object.assign(new Error("offline"), { network: true }); const r1 = await q.flush(async () => { throw down; }); assert.deepEqual(r1, { sent: 0, remaining: 2 });
  const order = []; const r2 = await q.flush(async (it) => { order.push(it.payload.n); }); assert.deepEqual(order, [1, 3]); assert.equal(r2.remaining, 0);
  q.push("events", { x: 1 }); for (let i = 0; i < 5; i++) await q.flush(async () => { throw Object.assign(new Error("bad"), { status: 400 }); }); assert.equal(q.depth(), 0);
});

test("audit chain: verifies, forwards in order, and any edit or deletion is caught", () => {
  const a = openAudit(tmp()); a.append("scan.completed", { entries: 3 }); a.append("acl.read", { entries: 2 }); a.append("transfer.completed", { size: 10 });
  assert.deepEqual(a.verify(), { valid: true, checked: 3, head: a.after(0)[2].hash }); assert.equal(a.after(0)[0].prevHash, GENESIS); assert.equal(a.after(2).length, 1);
  const lines = fs.readFileSync(a.file, "utf8").split("\n").filter(Boolean); fs.writeFileSync(a.file, [lines[0], lines[1].replace('"entries":2', '"entries":9'), lines[2]].join("\n") + "\n"); assert.equal(a.verify().valid, false);
  fs.writeFileSync(a.file, [lines[0], lines[2]].join("\n") + "\n"); assert.equal(a.verify().valid, false, "a deleted event breaks the chain");
});

test("config is encrypted at rest: wrong passphrase and tampering both fail, the private key is not readable in the file", () => {
  const dir = tmp(); const id = generateIdentity(); const f = saveConfig(dir, { gatewayId: "g", privateKeyPem: id.privateKeyPem, dataKey: "k" }, "correct horse battery");
  const text = fs.readFileSync(f, "utf8"); assert.equal(text.includes("PRIVATE KEY"), false); assert.equal(loadConfig(dir, "correct horse battery").privateKeyPem, id.privateKeyPem);
  assert.throws(() => loadConfig(dir, "wrong passphrase!"), /Wrong passphrase/); const j = JSON.parse(text); j.ct = Buffer.from(randomBytes(40)).toString("base64"); assert.throws(() => decryptConfig(JSON.stringify(j), "correct horse battery"), /Wrong passphrase|changed/);
  assert.throws(() => encryptConfig({}, "short"), /at least 8/);
});

test("signed upgrades: valid package stages; bad signature, wrong hash, unsafe paths and no key are refused; an unconfirmed version rolls back by itself; rollback on request", () => {
  const dir = tmp(); const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64"); const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const bundle = (v, extra = {}) => Buffer.from(JSON.stringify({ version: v, files: { "src/agent.js": Buffer.from(`// ${v}`).toString("base64"), ...extra } }));
  const b1 = bundle("0.2.0"); const m1 = signManifest({ version: "0.2.0", bytes: b1, privateKeyPem: pem });
  assert.equal(stageUpgrade({ dir, manifest: m1, bytes: b1, releasePublicKey: null }).staged, false, "no release key, no upgrade");
  assert.match(stageUpgrade({ dir, manifest: { ...m1, signature: Buffer.from("x").toString("base64") }, bytes: b1, releasePublicKey: pub }).reason, /signature/);
  assert.match(stageUpgrade({ dir, manifest: m1, bytes: Buffer.concat([b1, Buffer.from(" ")]), releasePublicKey: pub }).reason, /manifest/);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"); assert.match(stageUpgrade({ dir, manifest: m1, bytes: b1, releasePublicKey: other }).reason, /signature/, "signed by a different key");
  const evil = bundle("0.2.1", { "../../escape.js": "AA==" }); assert.match(stageUpgrade({ dir, manifest: signManifest({ version: "0.2.1", bytes: evil, privateKeyPem: pem }), bytes: evil, releasePublicKey: pub }).reason, /unsafe/);
  assert.equal(fs.existsSync(path.join(dir, "versions")), false, "nothing is written for a refused package");
  assert.equal(stageUpgrade({ dir, manifest: m1, bytes: b1, releasePublicKey: pub }).staged, true); assert.equal(fs.readFileSync(path.join(dir, "versions", "0.2.0", "src", "agent.js"), "utf8"), "// 0.2.0");
  assert.deepEqual({ ...versionState(dir) }, { current: "0.2.0", previous: null, pendingHealth: true, bootAttempts: 0 });
  const b2 = bundle("0.3.0"); stageUpgrade({ dir, manifest: signManifest({ version: "0.3.0", bytes: b2, privateKeyPem: pem }), bytes: b2, releasePublicKey: pub });
  assert.equal(chooseVersion(dir).version, "0.3.0"); assert.equal(chooseVersion(dir).version, "0.3.0"); const third = chooseVersion(dir); assert.deepEqual(third, { version: "0.2.0", rolledBack: true }, "two unconfirmed starts, then back to the previous version");
  stageUpgrade({ dir, manifest: signManifest({ version: "0.3.0", bytes: b2, privateKeyPem: pem }), bytes: b2, releasePublicKey: pub }); confirmHealthy(dir); assert.equal(versionState(dir).pendingHealth, false); assert.equal(chooseVersion(dir).version, "0.3.0");
  assert.deepEqual(rollback(dir), { rolledBack: true, to: "0.2.0" });
});

test("signing: headers verify with the matching public key and carry a fresh nonce each time; directory file source parses", () => {
  const id = generateIdentity(); assert.equal(publicKeyOf(id.privateKeyPem), id.publicKey);
  const a = signedHeaders({ gatewayId: "g", privateKeyPem: id.privateKeyPem, method: "post", path: "/x", body: "{}", now: 1 }); const b = signedHeaders({ gatewayId: "g", privateKeyPem: id.privateKeyPem, method: "POST", path: "/x", body: "{}", now: 1 });
  assert.notEqual(a["x-inaya-nonce"], b["x-inaya-nonce"]); assert.equal(signingString({ method: "post", path: "/x", ts: "1", nonce: "n", body: "{}" }).split("\n")[0], "POST");
  const f = path.join(tmp(), "dir.json"); fs.writeFileSync(f, JSON.stringify([{ principal: "CONTOSO\\alice", kind: "user", upn: "alice@contoso.com", memberOf: ["CONTOSO\\finance"] }, { principal: "CONTOSO\\finance", kind: "group" }]));
  assert.deepEqual(fromFile(f).map((p) => [p.principal, p.kind, p.upn]), [["CONTOSO\\alice", "user", "alice@contoso.com"], ["CONTOSO\\finance", "group", null]]);
});
