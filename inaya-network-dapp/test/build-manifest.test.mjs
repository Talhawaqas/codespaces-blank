// test/build-manifest.test.mjs -- signed build manifests: tamper detection, wrong-key rejection, key pinning, and the CLI end to end.
// Throwaway keys only (generated in the test, never reused). Run: node --test --test-force-exit test/build-manifest.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalize, parseChecksums, buildManifest, signManifest, verifyManifest, checkArtifact, keyFingerprint, sha256Hex } from "../src/lib/buildManifest.js";

const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { priv: privateKey.export({ type: "pkcs8", format: "pem" }), pub: publicKey.export({ type: "spki", format: "pem" }) }; };
const H1 = "a".repeat(64), H2 = "b".repeat(64);
const manifest = () => buildManifest({ product: "dapp-desktop", version: "1.2.3", gitCommit: "0123456789abcdef0123456789abcdef01234567", builtAt: "2026-10-03T00:00:00Z", artifacts: [{ path: "b.AppImage", sha256: H2, size: 20 }, { path: "a.exe", sha256: H1.toUpperCase() }] });

test("canonicalize is order-independent and deterministic", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), canonicalize({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
});

test("buildManifest sorts and normalises artifacts and rejects malformed input", () => {
  const m = manifest();
  assert.deepEqual(m.artifacts.map((a) => a.path), ["a.exe", "b.AppImage"]);
  assert.equal(m.artifacts[0].sha256, H1, "hashes are lower-cased");
  assert.throws(() => buildManifest({ product: "p", version: "1", gitCommit: "nothex", artifacts: [{ path: "x", sha256: H1 }] }), /commit/);
  assert.throws(() => buildManifest({ product: "p", version: "1", gitCommit: "abcdef1", artifacts: [] }), /at least one/);
  assert.throws(() => buildManifest({ product: "p", version: "1", gitCommit: "abcdef1", artifacts: [{ path: "x", sha256: "short" }] }), /SHA-256/);
  assert.throws(() => buildManifest({ product: "p", version: "1", gitCommit: "abcdef1", artifacts: [{ path: "x", sha256: H1 }, { path: "x", sha256: H2 }] }), /twice/);
});

test("parseChecksums reads sha256sum output (text and binary markers) and rejects junk", () => {
  assert.deepEqual(parseChecksums(`${H1}  a.exe\n${H2} *b.AppImage\n\n`), [{ path: "a.exe", sha256: H1 }, { path: "b.AppImage", sha256: H2 }]);
  assert.throws(() => parseChecksums("not a checksum line"), /line 1/);
});

test("a valid signature verifies; any change to the manifest, the signature or the key is rejected", () => {
  const { priv, pub } = pair(); const m = manifest(); const sig = signManifest(m, priv);
  assert.equal(verifyManifest({ manifest: m, signature: sig, publicKeyPem: pub }).ok, true);
  const reordered = JSON.parse(JSON.stringify(m)); // key order in the JSON file must not matter
  assert.equal(verifyManifest({ manifest: Object.fromEntries(Object.entries(reordered).reverse()), signature: sig, publicKeyPem: pub }).ok, true);
  const swapped = JSON.parse(JSON.stringify(m)); swapped.artifacts[0].sha256 = H2;
  assert.match(verifyManifest({ manifest: swapped, signature: sig, publicKeyPem: pub }).reason, /does not match/);
  const newer = { ...m, version: "9.9.9" };
  assert.equal(verifyManifest({ manifest: newer, signature: sig, publicKeyPem: pub }).ok, false);
  assert.equal(verifyManifest({ manifest: m, signature: sig.slice(0, -4) + "AAAA", publicKeyPem: pub }).ok, false);
  assert.equal(verifyManifest({ manifest: m, signature: sig, publicKeyPem: pair().pub }).ok, false, "a different key");
  assert.match(verifyManifest({ manifest: { ...m, schema: "x" }, signature: sig, publicKeyPem: pub }).reason, /format/);
  assert.equal(verifyManifest({ manifest: m, signature: "", publicKeyPem: pub }).ok, false);
  assert.match(verifyManifest({ manifest: m, signature: sig, publicKeyPem: "garbage" }).reason, /Could not verify/, "bad input returns a reason, it does not throw");
});

test("key pinning: the right fingerprint passes, another key's fingerprint fails even with a valid signature", () => {
  const a = pair(), b = pair(); const m = manifest(); const sig = signManifest(m, a.priv);
  assert.equal(verifyManifest({ manifest: m, signature: sig, publicKeyPem: a.pub, pinnedFingerprint: keyFingerprint(a.pub) }).ok, true);
  const mis = verifyManifest({ manifest: m, signature: sig, publicKeyPem: a.pub, pinnedFingerprint: keyFingerprint(b.pub) });
  assert.equal(mis.ok, false); assert.match(mis.reason, /pinned/);
});

test("signing refuses a non-Ed25519 key", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => signManifest(manifest(), privateKey.export({ type: "pkcs8", format: "pem" })), /Ed25519/);
});

test("checkArtifact accepts the released file, rejects a modified one and one that is not in the release", () => {
  const m = manifest();
  assert.equal(checkArtifact(m, { path: "a.exe", sha256: H1 }).ok, true);
  assert.match(checkArtifact(m, { path: "a.exe", sha256: H2 }).reason, /not the released file/);
  assert.match(checkArtifact(m, { path: "c.deb", sha256: H1 }).reason, /not part of release/);
});

test("CLI end to end: keygen, generate, sign, verify (with a downloaded file), then tamper with the file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-"));
  try {
    const run = (...args) => spawnSync(process.execPath, ["scripts/build-manifest.mjs", ...args], { encoding: "utf8" });
    const kg = run("keygen", dir); assert.equal(kg.status, 0, kg.stderr);
    const fp = kg.stdout.match(/fingerprint[^:]*: ([0-9a-f]{64})/)[1];
    const file = path.join(dir, "inaya-app.AppImage"); writeFileSync(file, "release bytes");
    writeFileSync(path.join(dir, "CHECKSUMS.txt"), `${sha256Hex("release bytes")}  inaya-app.AppImage\n`);
    const gen = run("generate", "--product", "dapp-desktop", "--version", "1.0.0", "--checksums", path.join(dir, "CHECKSUMS.txt"), "--dir", dir, "--commit", "0123456789abcdef0123456789abcdef01234567", "--out", path.join(dir, "m.json"));
    assert.equal(gen.status, 0, gen.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "m.json"), "utf8")).artifacts[0].size, 13, "size is taken from the file");
    const sg = run("sign", "--manifest", path.join(dir, "m.json"), "--key", path.join(dir, "release-signing.key")); assert.equal(sg.status, 0, sg.stderr);
    const v = run("verify", "--manifest", path.join(dir, "m.json"), "--sig", path.join(dir, "m.json.sig"), "--pub", path.join(dir, "release-signing.pub"), "--pin", fp, "--file", file);
    assert.equal(v.status, 0, v.stderr); assert.match(v.stdout, /matches the signed release/);
    writeFileSync(file, "tampered bytes");
    const bad = run("verify", "--manifest", path.join(dir, "m.json"), "--sig", path.join(dir, "m.json.sig"), "--pub", path.join(dir, "release-signing.pub"), "--file", file);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /not the released file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
