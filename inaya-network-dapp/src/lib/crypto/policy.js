// src/lib/crypto/policy.js
//
// FIPS-ready cryptography abstraction (Competitive Expansion SOW P4, COMPLIANCE-004). What it gives you, and what it does NOT:
//
//   * a registry of cryptographic PROVIDERS and the capabilities each declares;
//   * an ALGORITHM POLICY: which algorithms are in the NIST-approved set and which are not, and a compliance mode (`standard` or `fips_ready`) that REFUSES non-approved ones;
//   * known-answer self-tests (published test vectors) and pairwise-consistency checks, run against every provider that is available, so a provider cannot silently drift;
//   * a crypto INVENTORY and a cryptographic module DEPENDENCY inventory.
//
// IT DOES NOT MAKE ANYTHING FIPS 140-3 VALIDATED. The noble libraries this product uses in some places are strong, widely reviewed JavaScript implementations and are NOT validated
// cryptographic modules. Node's own crypto is OpenSSL; it is a validated-module candidate ONLY when Node is started with a validated FIPS provider in FIPS mode. The status below
// reports exactly that, and reaches FIPS_READY only when the runtime reports FIPS mode AND the operator has recorded a validation reference. Inaya does not verify that reference.
// A certified provider can be plugged in later by registering it; the application code asks the policy, not a specific library.

import nodeCrypto, { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, generateKeyPairSync, sign, verify, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class AlgorithmNotApproved extends Error { constructor(id, mode) { super(`The algorithm "${id}" is not in the approved set while the cryptographic mode is "${mode}".`); this.algorithm = id; this.status = 409; } }

// id -> { family, approved, note }. "approved" = in the NIST-approved set for the stated use (SP 800-38D, FIPS 180-4, FIPS 198-1, SP 800-132, SP 800-56C, FIPS 186-5, SP 800-90A).
export const ALGORITHMS = {
  "aes-256-gcm": { family: "symmetric-aead", approved: true, note: "SP 800-38D" }, "aes-128-gcm": { family: "symmetric-aead", approved: true, note: "SP 800-38D" },
  "sha-256": { family: "hash", approved: true, note: "FIPS 180-4" }, "sha-384": { family: "hash", approved: true, note: "FIPS 180-4" }, "sha-512": { family: "hash", approved: true, note: "FIPS 180-4" },
  "hmac-sha-256": { family: "mac", approved: true, note: "FIPS 198-1" }, "hmac-sha-512": { family: "mac", approved: true, note: "FIPS 198-1" },
  "pbkdf2-hmac-sha-256": { family: "kdf", approved: true, note: "SP 800-132 (use 600,000+ iterations for new passwords)" }, "hkdf-sha-256": { family: "kdf", approved: true, note: "SP 800-56C" },
  "ecdsa-p-256": { family: "signature", approved: true, note: "FIPS 186-5" }, "ecdsa-p-384": { family: "signature", approved: true, note: "FIPS 186-5" }, "ed25519": { family: "signature", approved: true, note: "FIPS 186-5 (EdDSA)" },
  "ecdh-p-256": { family: "key-agreement", approved: true, note: "SP 800-56A" }, "rsa-pss-2048": { family: "signature", approved: true, note: "FIPS 186-5 (2048 bits or more)" },
  "drbg": { family: "random", approved: true, note: "SP 800-90A (OS or module DRBG)" },
  "chacha20-poly1305": { family: "symmetric-aead", approved: false, note: "Not in the NIST-approved set" }, "x25519": { family: "key-agreement", approved: false, note: "Not treated as approved here" },
  "scrypt": { family: "kdf", approved: false, note: "Not in the NIST-approved set" }, "argon2id": { family: "kdf", approved: false, note: "Not in the NIST-approved set" },
  "ecdsa-secp256k1": { family: "signature", approved: false, note: "Blockchain wallet curve; not NIST-approved" }, "keccak-256": { family: "hash", approved: false, note: "Ethereum hash; not NIST-approved (SHA-3 is, Keccak-256 as used by Ethereum is not)" },
  "sha-1": { family: "hash", approved: false, note: "Legacy" }, "md5": { family: "hash", approved: false, note: "Broken" },
};
export const MODES = ["standard", "fips_ready"];
export const currentMode = (env = process.env) => (env.INAYA_CRYPTO_MODE === "fips_ready" ? "fips_ready" : "standard");
export function algorithmAllowed(id, mode = currentMode()) { const a = ALGORITHMS[id]; if (!a) return false; return mode === "fips_ready" ? a.approved : true; }
export function assertAlgorithm(id, mode = currentMode()) { if (!ALGORITHMS[id]) throw new Error(`Unknown algorithm "${id}".`); if (!algorithmAllowed(id, mode)) throw new AlgorithmNotApproved(id, mode); return ALGORITHMS[id]; }

// ------------------------------------------------------------------------------------------------ providers
const hasNoble = async () => { try { await import("@noble/hashes/sha2.js"); return true; } catch { return false; } };
export async function providers() {
  const fips = typeof nodeCrypto.getFips === "function" ? nodeCrypto.getFips() === 1 : false;
  return [
    { id: "node-openssl", label: "Node.js crypto (OpenSSL)", kind: "native", available: true, runtimeFipsMode: fips, validated: false, capabilities: ["aes-256-gcm", "aes-128-gcm", "sha-256", "sha-384", "sha-512", "hmac-sha-256", "hmac-sha-512", "pbkdf2-hmac-sha-256", "hkdf-sha-256", "ecdsa-p-256", "ecdsa-p-384", "ed25519", "ecdh-p-256", "rsa-pss-2048", "drbg", "chacha20-poly1305", "x25519", "scrypt"], note: fips ? "The runtime reports FIPS mode. Validation of the underlying module is not verified by Inaya." : "FIPS mode is OFF in this runtime." },
    { id: "noble-js", label: "noble libraries (pure JavaScript)", kind: "software", available: await hasNoble(), runtimeFipsMode: false, validated: false, capabilities: ["aes-256-gcm", "sha-256", "sha-512", "hmac-sha-256", "pbkdf2-hmac-sha-256", "chacha20-poly1305", "x25519", "ed25519", "ecdsa-secp256k1", "scrypt"], note: "Widely reviewed implementations; NOT validated cryptographic modules." },
    { id: "certified-module", label: "Validated cryptographic module (not installed)", kind: "future", available: false, runtimeFipsMode: false, validated: false, capabilities: [], note: "Register a validated provider here when one is adopted. Application code asks the policy, so it does not need rewriting." },
  ];
}

/** FIPS status. Reaches FIPS_READY only with BOTH the runtime in FIPS mode AND an operator-recorded validation reference. Never claims "validated". */
export function fipsStatus(env = process.env) {
  const runtime = typeof nodeCrypto.getFips === "function" ? nodeCrypto.getFips() === 1 : false; const ref = String(env.INAYA_FIPS_VALIDATION_REF || "").trim().slice(0, 200) || null;
  const status = runtime && ref ? "FIPS_READY" : runtime ? "FIPS_RUNTIME_ENABLED" : "NOT_VALIDATED";
  return { status, runtimeFipsMode: runtime, validationReference: ref, cryptoMode: currentMode(env), claim: "Inaya does not claim FIPS 140-3 validation. FIPS_READY means the runtime reports FIPS mode and the operator recorded a validation reference for the module; Inaya has not verified that reference.", explanation: status === "FIPS_READY" ? "Runtime in FIPS mode with a recorded module validation reference." : status === "FIPS_RUNTIME_ENABLED" ? "Runtime reports FIPS mode, but no validation reference is recorded." : "The runtime is not in FIPS mode. The cryptography in use is strong but not validated." };
}

// ------------------------------------------------------------------------------------------------ self tests (published vectors)
const zeros = (n) => Buffer.alloc(n);
const KAT = {
  "sha-256": () => createHash("sha256").update("abc").digest("hex") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "hmac-sha-256": () => createHmac("sha256", Buffer.alloc(20, 0x0b)).update("Hi There").digest("hex") === "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  "aes-256-gcm": () => { const c = createCipheriv("aes-256-gcm", zeros(32), zeros(12)); const ct = Buffer.concat([c.update(zeros(16)), c.final()]); const tag = c.getAuthTag(); const empty = createCipheriv("aes-256-gcm", zeros(32), zeros(12)); empty.final(); return ct.toString("hex") === "cea7403d4d606b6e074ec5d3baf39d18" && tag.toString("hex") === "d0d1c8a799996bf0265b98b5d48ab919" && empty.getAuthTag().toString("hex") === "530f8afbc74536b9a963b4f1c4cb738b"; },
  "pbkdf2-hmac-sha-256": () => pbkdf2Sync("passwd", "salt", 1, 64, "sha256").toString("hex") === "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
};
const PAIRWISE = {
  "ecdsa-p-256": () => { const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }); const m = randomBytes(32); return verify("sha256", m, publicKey, sign("sha256", m, privateKey)) && !verify("sha256", Buffer.concat([m, Buffer.from([1])]), publicKey, sign("sha256", m, privateKey)); },
  "ed25519": () => { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const m = randomBytes(32); const sig = sign(null, m, privateKey); return verify(null, m, publicKey, sig) && !verify(null, randomBytes(32), publicKey, sig); },
  "aes-256-gcm-roundtrip": () => { const k = randomBytes(32), iv = randomBytes(12), m = randomBytes(100); const c = createCipheriv("aes-256-gcm", k, iv); const ct = Buffer.concat([c.update(m), c.final()]); const d = createDecipheriv("aes-256-gcm", k, iv); d.setAuthTag(c.getAuthTag()); const ok = Buffer.concat([d.update(ct), d.final()]).equals(m); const bad = createDecipheriv("aes-256-gcm", k, iv); bad.setAuthTag(Buffer.alloc(16)); let tamper = false; try { bad.update(ct); bad.final(); } catch { tamper = true; } return ok && tamper; },
};
export function selfTest() {
  const results = []; for (const [id, fn] of Object.entries(KAT)) { let pass = false, error = null; try { pass = !!fn(); } catch (e) { error = String(e.message).slice(0, 80); } results.push({ id, kind: "known-answer", provider: "node-openssl", pass, error }); }
  for (const [id, fn] of Object.entries(PAIRWISE)) { let pass = false, error = null; try { pass = !!fn(); } catch (e) { error = String(e.message).slice(0, 80); } results.push({ id, kind: "pairwise-consistency", provider: "node-openssl", pass, error }); }
  return { passed: results.every((r) => r.pass), results, ranAt: new Date().toISOString() };
}
/** The same known-answer vectors against the noble implementation, so two independent implementations must agree with the published values. */
export async function selfTestNoble() {
  const out = []; const check = async (id, fn) => { let pass = false, error = null; try { pass = !!(await fn()); } catch (e) { error = String(e.message).slice(0, 80); } out.push({ id, kind: "known-answer", provider: "noble-js", pass, error }); };
  let sha256, hmac, pbkdf2, gcm, bytesToHex;
  ({ sha256 } = await import("@noble/hashes/sha2.js")); try { ({ hmac } = await import("@noble/hashes/hmac.js")); } catch { /* optional */ } try { ({ pbkdf2 } = await import("@noble/hashes/pbkdf2.js")); } catch { /* optional */ } try { ({ gcm } = await import("@noble/ciphers/aes.js")); } catch { /* optional */ }
  try { ({ bytesToHex } = await import("@noble/hashes/utils.js")); } catch { bytesToHex = (u) => Buffer.from(u).toString("hex"); }
  await check("sha-256", () => bytesToHex(sha256(new TextEncoder().encode("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  if (hmac) await check("hmac-sha-256", () => bytesToHex(hmac(sha256, new Uint8Array(20).fill(0x0b), new TextEncoder().encode("Hi There"))) === "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  if (pbkdf2) await check("pbkdf2-hmac-sha-256", () => bytesToHex(pbkdf2(sha256, new TextEncoder().encode("passwd"), new TextEncoder().encode("salt"), { c: 1, dkLen: 64 })) === "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783");
  if (gcm) await check("aes-256-gcm", () => { const ct = gcm(new Uint8Array(32), new Uint8Array(12)).encrypt(new Uint8Array(16)); return bytesToHex(ct) === "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919"; });
  return { passed: out.length > 0 && out.every((r) => r.pass), results: out };
}

// ------------------------------------------------------------------------------------------------ inventory
/** Where cryptography is used. Maintained by hand next to the code it describes; a test checks its shape and that every algorithm named exists in the registry. */
export const USAGE = [
  { subsystem: "Documents (workspace)", purpose: "Client-side encryption of file content before it leaves the browser; shards pinned to two providers", algorithms: ["aes-256-gcm", "pbkdf2-hmac-sha-256", "sha-256"], keyHolder: "the person (passkey)", library: "WebCrypto / noble" },
  { subsystem: "S3 / Azure compatible layer", purpose: "Server-managed envelope encryption of objects", algorithms: ["aes-256-gcm", "hmac-sha-256", "sha-256"], keyHolder: "the platform, or a customer-managed key provider", library: "Node crypto" },
  { subsystem: "Secure Chat", purpose: "End-to-end encrypted messaging (MLS, RFC 9420)", algorithms: ["aes-128-gcm", "ecdsa-p-256", "ed25519", "x25519", "sha-256", "hkdf-sha-256"], keyHolder: "each device", library: "ts-mls (not formally audited)" },
  { subsystem: "Secure Notes", purpose: "Client-side encrypted notes", algorithms: ["aes-256-gcm", "pbkdf2-hmac-sha-256"], keyHolder: "the person (notes passphrase)", library: "WebCrypto" },
  { subsystem: "Secure sharing and file requests", purpose: "Link keys, sealed uploads to a request key", algorithms: ["aes-256-gcm", "ecdh-p-256", "sha-256"], keyHolder: "link holder / requester's browser", library: "WebCrypto" },
  { subsystem: "Sessions, links and API keys", purpose: "Random tokens stored only as hashes", algorithms: ["sha-256", "drbg"], keyHolder: "n/a (hash only)", library: "Node crypto" },
  { subsystem: "Webhooks and gateway requests", purpose: "Signed requests", algorithms: ["hmac-sha-256", "ed25519"], keyHolder: "endpoint secret / gateway private key", library: "Node crypto" },
  { subsystem: "Audit chain", purpose: "Tamper-evident hash chain", algorithms: ["sha-256"], keyHolder: "n/a", library: "Node crypto" },
  { subsystem: "Integration secrets", purpose: "Encrypted third-party credentials at rest", algorithms: ["aes-256-gcm"], keyHolder: "the platform (INTEGRATION_ENCRYPTION_KEY)", library: "Node crypto" },
  { subsystem: "Wallet and chain operations", purpose: "Blockchain signatures", algorithms: ["ecdsa-secp256k1", "keccak-256"], keyHolder: "wallet owner / platform operator", library: "ethers, secp256k1" },
  { subsystem: "Gateway agent", purpose: "Local configuration and file encryption", algorithms: ["aes-256-gcm", "ed25519", "sha-256", "hkdf-sha-256"], keyHolder: "the customer", library: "Node crypto" },
];
const CRYPTO_PACKAGES = ["ethers", "@noble/ciphers", "@noble/hashes", "secp256k1", "ts-mls", "bcryptjs", "jsonwebtoken", "jose", "otplib", "speakeasy", "@simplewebauthn/server", "firebase-admin"];
export function dependencyInventory({ cwd = process.cwd() } = {}) {
  let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch { pkg = null; } const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  return { source: pkg ? "package.json" : "unavailable", modules: [{ name: "node:crypto", kind: "runtime", version: process.version, validated: false, note: "OpenSSL as built into this Node.js; FIPS mode only when started with a validated provider." }, { name: "WebCrypto (browser)", kind: "runtime", version: null, validated: false, note: "The user's browser; not controlled by Inaya." }, ...CRYPTO_PACKAGES.filter((n) => deps[n]).map((n) => ({ name: n, kind: "package", version: deps[n], validated: false, note: "Not a validated cryptographic module." }))] };
}
export async function inventory() {
  const prov = await providers();
  return { mode: currentMode(), fips: fipsStatus(), providers: prov, algorithms: Object.entries(ALGORITHMS).map(([id, a]) => ({ id, ...a })), usage: USAGE.map((u) => ({ ...u, allApproved: u.algorithms.every((a) => ALGORITHMS[a]?.approved), notApproved: u.algorithms.filter((a) => !ALGORITHMS[a]?.approved) })), dependencies: dependencyInventory() };
}
