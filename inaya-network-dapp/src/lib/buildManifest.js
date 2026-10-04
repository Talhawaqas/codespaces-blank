// src/lib/buildManifest.js
//
// Signed build manifests (Reproducible Builds SOW follow-up). A manifest says: "release X of product P was built from
// git commit C and consists of exactly these files with these SHA-256 hashes." It is signed with an Ed25519 key whose
// PUBLIC half is published somewhere other than the server being checked (the repo, the docs, a pinned constant in a
// client), so a client can detect a server that serves something other than what was released, without trusting that
// server's word for it.
//
// Pure: Node's crypto only, no I/O, so the same code runs in the CLI (scripts/build-manifest.mjs), tests and any client.
// Honest limits: this proves the manifest was signed by the holder of the private key. It does not prove the build is
// reproducible, nor that the key was not stolen, and it says nothing about content a shell loads at runtime.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export const MANIFEST_SCHEMA = "inaya-build-manifest/1";
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Deterministic JSON: object keys sorted at every depth, no whitespace. The signed bytes are exactly this string. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** Parses sha256sum-style text ("<hex>  <name>" / "<hex> *<name>") into [{ path, sha256 }]. Throws on a malformed line. */
export function parseChecksums(text) {
  const out = [];
  for (const [i, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) throw new Error(`Checksums line ${i + 1} is not "<sha256>  <file>".`);
    out.push({ path: m[2].trim(), sha256: m[1].toLowerCase() });
  }
  return out;
}

/** Builds the unsigned manifest body. `artifacts` is [{ path, sha256, size? }]; order does not matter (it is sorted). */
export function buildManifest({ product, version, gitCommit, builtAt, artifacts, notes }) {
  if (!product || !version) throw new Error("product and version are required.");
  if (!/^[0-9a-f]{7,40}$/i.test(gitCommit || "")) throw new Error("gitCommit must be a git commit hash.");
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("A manifest needs at least one artifact.");
  const seen = new Set();
  const list = artifacts.map((a) => {
    if (!a.path || !SHA256_HEX.test(String(a.sha256 || "").toLowerCase())) throw new Error(`Artifact "${a?.path}" needs a path and a SHA-256.`);
    if (seen.has(a.path)) throw new Error(`Artifact "${a.path}" is listed twice.`);
    seen.add(a.path);
    return { path: a.path, sha256: a.sha256.toLowerCase(), ...(Number.isInteger(a.size) ? { size: a.size } : {}) };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { schema: MANIFEST_SCHEMA, product, version, gitCommit: gitCommit.toLowerCase(), builtAt: builtAt || null, artifacts: list, ...(notes ? { notes } : {}) };
}

const toKey = (pem, kind) => (kind === "private" ? createPrivateKey(pem) : createPublicKey(pem));

/** Detached signature (base64) over the canonical manifest. Needs an Ed25519 private key in PEM (PKCS#8). */
export function signManifest(manifest, privateKeyPem) {
  const key = toKey(privateKeyPem, "private");
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be an Ed25519 key.");
  return cryptoSign(null, Buffer.from(canonicalize(manifest)), key).toString("base64");
}

/** Public key fingerprint (SHA-256 of the SPKI DER), so a client can pin "which key" without shipping the whole PEM. */
export function keyFingerprint(publicKeyPem) {
  return sha256Hex(toKey(publicKeyPem, "public").export({ type: "spki", format: "der" }));
}

/**
 * Verifies the signature, the schema and (optionally) that a given file really is in the manifest.
 * Returns { ok, reason?, manifest? }. Never throws on bad input: a verifier that crashes is a verifier that gets bypassed.
 * `pinnedFingerprint` (optional) additionally requires the verifying key to be the one the caller has pinned.
 */
export function verifyManifest({ manifest, signature, publicKeyPem, pinnedFingerprint = null }) {
  try {
    if (!manifest || manifest.schema !== MANIFEST_SCHEMA) return { ok: false, reason: "Unrecognised manifest format." };
    const key = toKey(publicKeyPem, "public");
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, reason: "The verification key must be an Ed25519 key." };
    if (pinnedFingerprint && keyFingerprint(publicKeyPem) !== String(pinnedFingerprint).toLowerCase()) return { ok: false, reason: "The verification key is not the pinned release key." };
    const good = cryptoVerify(null, Buffer.from(canonicalize(manifest)), key, Buffer.from(String(signature || ""), "base64"));
    return good ? { ok: true, manifest } : { ok: false, reason: "The signature does not match this manifest." };
  } catch (err) {
    return { ok: false, reason: `Could not verify: ${err.message}` };
  }
}

/** Is this exact file (by hash) part of the signed release? Call only after verifyManifest().ok. */
export function checkArtifact(manifest, { path, sha256 }) {
  const entry = manifest.artifacts.find((a) => a.path === path);
  if (!entry) return { ok: false, reason: `"${path}" is not part of release ${manifest.version}.` };
  if (entry.sha256 !== String(sha256).toLowerCase()) return { ok: false, reason: `"${path}" does not match the signed hash: it is not the released file.` };
  return { ok: true };
}
