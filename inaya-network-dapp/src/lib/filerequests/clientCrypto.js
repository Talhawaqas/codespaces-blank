// src/lib/filerequests/clientCrypto.js
//
// File requests (Competitive Expansion SOW B3): the cryptography that runs in browsers. Standard WebCrypto only; nothing invented.
//
//   Requester (owner), when creating a request:  generateRequestKeys(passphrase)
//       -> an ECDH P-256 key pair. The PUBLIC key goes to Inaya and onto the upload page. The PRIVATE key never leaves the owner's browser in
//          the clear: it is wrapped (AES-256-GCM) under a key derived from the owner's passphrase with PBKDF2-SHA256 and that opaque blob is
//          stored with the request, so the owner can open uploads later from any browser by typing the passphrase. Inaya cannot.
//   Uploader (no account):                        encryptForRequest(publicKeyJwk, bytes, meta, aad)
//       -> a fresh random 256-bit file key encrypts [meta + file] (AES-256-GCM); that file key is sealed to the request's public key with an
//          ephemeral ECDH + HKDF-SHA256 + AES-256-GCM "sealed box". Only ciphertext and the sealed key leave the uploader's browser.
//   Requester, to open an upload:                 unwrapPrivateKey(...) then decryptFromRequest(...)
//
// `aad` (the request id) is bound into both encryption layers, so an upload cannot be moved to a different request and still decrypt.

const te = new TextEncoder(); const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const b64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
const unb64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const PBKDF2_ITERATIONS = 310_000;
const INFO = te.encode("inaya-file-request-v1");

async function passphraseKey(passphrase, salt, iterations) {
  const base = await subtle().importKey("raw", te.encode(String(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Owner side. Returns { publicKeyJwk, wrappedPrivateKey } (the second is an opaque string to store with the request). */
export async function generateRequestKeys(passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!passphrase || String(passphrase).length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKeyJwk = await subtle().exportKey("jwk", pair.publicKey);
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const salt = rnd(16); const iv = rnd(12);
  const wrapKey = await passphraseKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, wrapKey, pkcs8));
  pkcs8.fill(0);
  return { publicKeyJwk: { kty: publicKeyJwk.kty, crv: publicKeyJwk.crv, x: publicKeyJwk.x, y: publicKeyJwk.y }, wrappedPrivateKey: JSON.stringify({ v: 1, iter: iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) }) };
}

export async function unwrapPrivateKey(wrappedPrivateKey, passphrase) {
  let w; try { w = JSON.parse(wrappedPrivateKey); } catch { throw new Error("The stored key is damaged."); }
  if (w.v !== 1) throw new Error("Unsupported key format.");
  try {
    const pkcs8 = await subtle().decrypt({ name: "AES-GCM", iv: unb64(w.iv) }, await passphraseKey(passphrase, unb64(w.salt), w.iter), unb64(w.ct));
    return await subtle().importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } catch { throw new Error("That passphrase does not open this request."); }
}

/** Server-side shape check for a public key someone sends us (the upload page trusts it, so it must be a real P-256 point). */
export function isValidPublicKeyJwk(jwk) {
  return !!jwk && jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string" && /^[A-Za-z0-9_-]{43}$/.test(jwk.x) && /^[A-Za-z0-9_-]{43}$/.test(jwk.y);
}

/** Sealed box: encrypt `fileKey` bytes to a P-256 public key (ephemeral ECDH + HKDF-SHA256 + AES-256-GCM). `info` separates uses (file requests, notes). */
export async function sealBytes(publicKeyJwk, fileKey, aad, info = INFO) {
  if (!isValidPublicKeyJwk(publicKeyJwk)) throw new Error("This request's key is not valid.");
  const recipient = await subtle().importKey("jwk", { ...publicKeyJwk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await subtle().deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const hk = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const wrapKey = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = rnd(12);
  const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, wrapKey, fileKey));
  const epk = await subtle().exportKey("jwk", eph.publicKey);
  return { v: 1, epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y }, iv: b64(iv), sealed: b64(sealed) };
}

/** Uploader side. `meta` (name, type, size) travels INSIDE the ciphertext. Returns { ciphertext, keyEnvelope(JSON string) }. */
export async function encryptForRequest(publicKeyJwk, bytes, meta, aad) {
  const aadBytes = typeof aad === "string" ? te.encode(aad) : aad;
  const fileKey = rnd(32); const iv = rnd(12);
  const header = te.encode(JSON.stringify({ v: 1, name: String(meta?.name || "file").slice(0, 200), type: String(meta?.type || "application/octet-stream").slice(0, 100), size: bytes.length }));
  const plain = new Uint8Array(4 + header.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, header.length); plain.set(header, 4); plain.set(bytes, 4 + header.length);
  const key = await subtle().importKey("raw", fileKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aadBytes }, key, plain));
  const env = await sealBytes(publicKeyJwk, fileKey, aadBytes);
  fileKey.fill(0);
  return { ciphertext, keyEnvelope: JSON.stringify({ ...env, fileIv: b64(iv) }) };
}

/** Requester side. Throws if anything was changed or the upload was moved to another request. */
export async function decryptFromRequest(privateKey, keyEnvelope, ciphertext, aad) {
  const aadBytes = typeof aad === "string" ? te.encode(aad) : aad;
  const env = JSON.parse(keyEnvelope); if (env.v !== 1) throw new Error("Unsupported upload format.");
  const eph = await subtle().importKey("jwk", { ...env.epk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: eph }, privateKey, 256);
  const hk = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const wrapKey = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const fileKeyBytes = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: unb64(env.iv), additionalData: aadBytes }, wrapKey, unb64(env.sealed)));
  const key = await subtle().importKey("raw", fileKeyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: unb64(env.fileIv), additionalData: aadBytes }, key, ciphertext));
  const hl = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  if (hl > 4096 || 4 + hl > plain.length) throw new Error("The upload is damaged.");
  const meta = JSON.parse(td.decode(plain.subarray(4, 4 + hl)));
  return { meta, bytes: plain.slice(4 + hl) };
}

/** Open a sealed box made by sealBytes. Returns the raw bytes. Throws if the key, aad or info differ or anything was altered. */
export async function openSealedBytes(privateKey, env, aad, info = INFO) {
  const aadBytes = typeof aad === "string" ? te.encode(aad) : aad;
  if (!env || env.v !== 1) throw new Error("Unsupported sealed key format.");
  const eph = await subtle().importKey("jwk", { ...env.epk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: eph }, privateKey, 256);
  const hk = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const wrapKey = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: unb64(env.iv), additionalData: aadBytes }, wrapKey, unb64(env.sealed)));
}
