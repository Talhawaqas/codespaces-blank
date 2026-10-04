// scripts/build-manifest.mjs -- create, sign and verify an Inaya signed build manifest (see src/lib/buildManifest.js).
//
//   node scripts/build-manifest.mjs keygen <dir>
//       Writes release-signing.key (PRIVATE, keep it secret) and release-signing.pub, prints the public key fingerprint.
//       Run this yourself, on a machine you trust, and store the private key only as a CI secret / in a password manager.
//   node scripts/build-manifest.mjs generate --product dapp-desktop --version 1.0.11 --checksums public/downloads/CHECKSUMS.txt [--dir public/downloads] [--commit <sha>] [--out manifest.json]
//   node scripts/build-manifest.mjs sign --manifest manifest.json --key release-signing.key [--out manifest.json.sig]
//       (the key may instead come from the BUILD_MANIFEST_PRIVATE_KEY environment variable, as PEM text)
//   node scripts/build-manifest.mjs verify --manifest manifest.json --sig manifest.json.sig --pub release-signing.pub [--pin <fingerprint>] [--file <path-to-downloaded-file>]
//       Exits 0 only if the signature is valid (and, with --file, the file's hash is in the manifest).

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { buildManifest, parseChecksums, signManifest, verifyManifest, checkArtifact, keyFingerprint, sha256Hex } from "../src/lib/buildManifest.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}
const die = (msg) => { console.error(msg); process.exit(1); };
const need = (a, k) => a[k] && a[k] !== true ? a[k] : die(`Missing --${k}`);

const [cmd, ...rest] = process.argv.slice(2);
const a = parseArgs(rest);

if (cmd === "keygen") {
  const dir = a._[0] || die("Usage: keygen <dir>");
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "pem" });
  const pub = publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(path.join(dir, "release-signing.key"), priv, { mode: 0o600 });
  writeFileSync(path.join(dir, "release-signing.pub"), pub);
  console.log(`Wrote ${dir}/release-signing.key (PRIVATE: store it only as a secret) and ${dir}/release-signing.pub.\nPublic key fingerprint (pin this in clients): ${keyFingerprint(pub)}`);
} else if (cmd === "generate") {
  const checksums = parseChecksums(readFileSync(need(a, "checksums"), "utf8"));
  const dir = a.dir && a.dir !== true ? a.dir : null;
  const artifacts = checksums.map((c) => {
    const file = dir ? path.join(dir, c.path) : null;
    return { ...c, ...(file && existsSync(file) ? { size: statSync(file).size } : {}) };
  });
  const commit = a.commit && a.commit !== true ? a.commit : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const m = buildManifest({ product: need(a, "product"), version: need(a, "version"), gitCommit: commit, builtAt: new Date().toISOString(), artifacts });
  const outFile = a.out && a.out !== true ? a.out : "manifest.json";
  writeFileSync(outFile, JSON.stringify(m, null, 2) + "\n");
  console.log(`Wrote ${outFile}: ${m.artifacts.length} artifacts, commit ${m.gitCommit.slice(0, 12)}.`);
} else if (cmd === "sign") {
  const manifestFile = need(a, "manifest");
  const pem = process.env.BUILD_MANIFEST_PRIVATE_KEY || (a.key && a.key !== true ? readFileSync(a.key, "utf8") : die("Provide --key <file> or set BUILD_MANIFEST_PRIVATE_KEY."));
  const sig = signManifest(JSON.parse(readFileSync(manifestFile, "utf8")), pem);
  const outFile = a.out && a.out !== true ? a.out : `${manifestFile}.sig`;
  writeFileSync(outFile, sig + "\n");
  console.log(`Wrote ${outFile}.`);
} else if (cmd === "verify") {
  const manifest = JSON.parse(readFileSync(need(a, "manifest"), "utf8"));
  const pub = readFileSync(need(a, "pub"), "utf8");
  const r = verifyManifest({ manifest, signature: readFileSync(need(a, "sig"), "utf8").trim(), publicKeyPem: pub, pinnedFingerprint: a.pin && a.pin !== true ? a.pin : null });
  if (!r.ok) die(`NOT VERIFIED: ${r.reason}`);
  console.log(`Signature valid: ${manifest.product} ${manifest.version}, commit ${manifest.gitCommit.slice(0, 12)}, ${manifest.artifacts.length} artifacts. Key ${keyFingerprint(pub).slice(0, 16)}...`);
  if (a.file && a.file !== true) {
    const c = checkArtifact(manifest, { path: path.basename(a.file), sha256: sha256Hex(readFileSync(a.file)) });
    if (!c.ok) die(`NOT VERIFIED: ${c.reason}`);
    console.log(`${path.basename(a.file)} matches the signed release.`);
  }
} else {
  die("Usage: build-manifest.mjs keygen|generate|sign|verify (see the header of this file)");
}
