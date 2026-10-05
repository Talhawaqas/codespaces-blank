// src/upgrade.js -- signed upgrade packages with rollback.
//
// A release is one JSON bundle { version, files: { "src/agent.js": "<base64>", ... } } plus a manifest { version, sha256, size, signature }. The signature is an
// Ed25519 signature, made by Inaya's release key, over `${version}\n${sha256}\n${size}`. The agent holds only the release PUBLIC key (configured by the
// operator); without it, upgrades are refused. A package that fails the signature, the hash, the size or the path checks is never written.
//
// Layout in the data directory:   versions/<version>/...   current.json { current, previous, pendingHealth, bootAttempts }
// The launcher (bin/inaya-gateway.mjs) runs versions/<current>/ when it exists. A new version is "pending" until the running agent confirms a healthy first
// cycle; if it fails to confirm in two starts, the launcher switches back to `previous` by itself. `rollback` does the same on request.
import fs from "node:fs";
import path from "node:path";
import { createHash, verify as edVerify, createPublicKey, sign as edSign, createPrivateKey } from "node:crypto";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export const manifestString = ({ version, sha256, size }) => `${version}\n${sha256}\n${size}`;
export const signManifest = ({ version, bytes, privateKeyPem }) => { const m = { version, sha256: sha(bytes), size: bytes.length }; return { ...m, signature: edSign(null, Buffer.from(manifestString(m)), createPrivateKey(privateKeyPem)).toString("base64") }; };
const safeRel = (p) => typeof p === "string" && p.length < 200 && !p.startsWith("/") && !p.includes("\\") && !/(^|\/)\.\.(\/|$)/.test(p) && /^[A-Za-z0-9._/-]+$/.test(p);
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function verifyPackage({ manifest, bytes, releasePublicKey }) {
  if (!releasePublicKey) return { ok: false, reason: "No release key is configured on this gateway, so upgrades are refused." };
  if (!manifest || !VERSION.test(String(manifest.version))) return { ok: false, reason: "The version is not valid." };
  if (bytes.length !== manifest.size || sha(bytes) !== manifest.sha256) return { ok: false, reason: "The package does not match its manifest." };
  let pub; try { pub = createPublicKey({ key: Buffer.from(releasePublicKey, "base64"), format: "der", type: "spki" }); } catch { return { ok: false, reason: "The release key is not valid." }; }
  let good = false; try { good = edVerify(null, Buffer.from(manifestString(manifest)), pub, Buffer.from(String(manifest.signature), "base64")); } catch { good = false; }
  return good ? { ok: true } : { ok: false, reason: "The package signature is not valid." };
}

const readState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8")); } catch { return { current: null, previous: null, pendingHealth: false, bootAttempts: 0 }; } };
const writeState = (dir, s) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, "current.json"); fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(f + ".tmp", f); };
export const versionState = readState;

export function stageUpgrade({ dir, manifest, bytes, releasePublicKey }) {
  const v = verifyPackage({ manifest, bytes, releasePublicKey }); if (!v.ok) return { staged: false, reason: v.reason };
  let bundle; try { bundle = JSON.parse(bytes.toString("utf8")); } catch { return { staged: false, reason: "The package is not readable." }; }
  if (bundle.version !== manifest.version || !bundle.files || typeof bundle.files !== "object") return { staged: false, reason: "The package contents do not match the manifest." };
  const names = Object.keys(bundle.files); if (!names.length || names.length > 200 || !names.every(safeRel) || !names.includes("src/agent.js")) return { staged: false, reason: "The package has unsafe or missing files." };
  const target = path.join(dir, "versions", manifest.version); fs.rmSync(target, { recursive: true, force: true });
  for (const n of names) { const f = path.join(target, ...n.split("/")); if (!path.resolve(f).startsWith(path.resolve(target) + path.sep)) { fs.rmSync(target, { recursive: true, force: true }); return { staged: false, reason: "A file path escapes the version folder." }; } fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(String(bundle.files[n]), "base64")); }
  const s = readState(dir); writeState(dir, { current: manifest.version, previous: s.current, pendingHealth: true, bootAttempts: 0 }); return { staged: true, version: manifest.version, previous: s.current };
}
/** Called by the running agent after a healthy first cycle on the new version. */
export function confirmHealthy(dir) { const s = readState(dir); if (s.pendingHealth) writeState(dir, { ...s, pendingHealth: false, bootAttempts: 0 }); return readState(dir); }
export function rollback(dir) { const s = readState(dir); if (!s.previous && s.current === null) return { rolledBack: false, reason: "There is no earlier version." }; const prev = s.previous; writeState(dir, { current: prev, previous: null, pendingHealth: false, bootAttempts: 0 }); return { rolledBack: true, to: prev }; }
/** Launcher logic: which version should start now? Counts the start of an unconfirmed version and falls back after the second failed start. */
export function chooseVersion(dir) {
  const s = readState(dir); if (!s.current) return { version: null };
  if (s.pendingHealth) { if (s.bootAttempts >= 2) { const r = rollback(dir); return { version: r.to, rolledBack: true }; } writeState(dir, { ...s, bootAttempts: s.bootAttempts + 1 }); }
  return { version: s.current };
}
