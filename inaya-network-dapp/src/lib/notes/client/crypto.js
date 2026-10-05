// src/lib/notes/client/crypto.js
//
// Secure Notes cryptography (runs in the browser; the tests run it in Node, which has the same WebCrypto). Standard primitives only:
//   AES-256-GCM, PBKDF2-SHA256 (310k), ECDH P-256 + HKDF-SHA256 sealed boxes (shared with file requests: src/lib/filerequests/clientCrypto.js).
// Every ciphertext binds its context in the AAD so the server cannot move it:
//   revision   noteId:rev:keyVersion
//   note key   noteId:keyVersion:recipientEmail   (sealed box)
//   index      index:<version>
//   private key / VK wrap   fixed labels

import { PBKDF2_ITERATIONS, isValidPublicKeyJwk, openSealedBytes, sealBytes } from "../../filerequests/clientCrypto.js";

const te = new TextEncoder(); const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const b64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
export const unb64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const INFO = te.encode("inaya-notes-v1");

export class NotesCryptoError extends Error { constructor(message, code) { super(message); this.code = code; } }

async function passphraseKey(passphrase, salt, iterations) {
  const base = await subtle().importKey("raw", te.encode(String(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function gcmEncrypt(key, bytes, aad) { const iv = rnd(12); const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, bytes)); return { iv: b64(iv), ct: b64(ct) }; }
async function gcmDecrypt(key, blob, aad) { return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: unb64(blob.iv), additionalData: te.encode(aad) }, key, unb64(blob.ct))); }
const aesKey = (raw, usages, extractable = false) => subtle().importKey("raw", raw, "AES-GCM", extractable, usages);

// ------------------------------------------------------------------------------------------------------------- vault
/** Create a vault. Returns { vault (send to the server), session (keep in memory) }. */
export async function createVaultKeys(passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!passphrase || String(passphrase).length < 10) throw new NotesCryptoError("Use a passphrase of at least 10 characters.", "WEAK_PASSPHRASE");
  const vkRaw = rnd(32); const salt = rnd(16);
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await subtle().exportKey("jwk", pair.publicKey); const publicKeyJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const vk = await aesKey(vkRaw, ["encrypt", "decrypt"]);
  const wrappedVk = await gcmEncrypt(await passphraseKey(passphrase, salt, iterations), vkRaw, "inaya-notes-vk");
  const encPrivateKey = await gcmEncrypt(vk, pkcs8, "inaya-notes-priv");
  pkcs8.fill(0); vkRaw.fill(0);
  const privateKey = await subtle().importKey("pkcs8", await gcmDecrypt(vk, encPrivateKey, "inaya-notes-priv"), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { vault: { publicKeyJwk, kdf: { salt: b64(salt), iter: iterations }, wrappedVk, encPrivateKey }, session: { vk, privateKey, publicKeyJwk } };
}

/** Open a vault with the passphrase. Throws NotesCryptoError("BAD_PASSPHRASE"). */
export async function openVault(vault, passphrase) {
  let vkRaw;
  try { vkRaw = await gcmDecrypt(await passphraseKey(passphrase, unb64(vault.kdf.salt), vault.kdf.iter), vault.wrappedVk, "inaya-notes-vk"); }
  catch { throw new NotesCryptoError("That passphrase does not open your notes.", "BAD_PASSPHRASE"); }
  const vk = await aesKey(vkRaw, ["encrypt", "decrypt"]); vkRaw.fill(0);
  const privateKey = await subtle().importKey("pkcs8", await gcmDecrypt(vk, vault.encPrivateKey, "inaya-notes-priv"), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { vk, privateKey, publicKeyJwk: vault.publicKeyJwk };
}

/** Change the passphrase: re-wrap the same vault key. Everything else in the vault stays identical. */
export async function rewrapVaultKeys(vault, oldPassphrase, newPassphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!newPassphrase || String(newPassphrase).length < 10) throw new NotesCryptoError("Use a passphrase of at least 10 characters.", "WEAK_PASSPHRASE");
  let vkRaw;
  try { vkRaw = await gcmDecrypt(await passphraseKey(oldPassphrase, unb64(vault.kdf.salt), vault.kdf.iter), vault.wrappedVk, "inaya-notes-vk"); }
  catch { throw new NotesCryptoError("Your current passphrase is not correct.", "BAD_PASSPHRASE"); }
  const salt = rnd(16); const wrappedVk = await gcmEncrypt(await passphraseKey(newPassphrase, salt, iterations), vkRaw, "inaya-notes-vk"); vkRaw.fill(0);
  return { ...vault, kdf: { salt: b64(salt), iter: iterations }, wrappedVk };
}

/** Short, human-comparable fingerprint of a public key, for "is this really them" checks. */
export async function fingerprint(publicKeyJwk) {
  const h = new Uint8Array(await subtle().digest("SHA-256", te.encode(`${publicKeyJwk.x}.${publicKeyJwk.y}`)));
  return [...h.slice(0, 10)].map((x) => x.toString(16).padStart(2, "0")).join("").replace(/(.{4})/g, "$1 ").trim().toUpperCase();
}

// ------------------------------------------------------------------------------------------------------------ index
export async function encryptIndex(vk, obj, version) { return gcmEncrypt(vk, te.encode(JSON.stringify(obj)), `index:${version}`); }
export async function decryptIndex(vk, blob, version) {
  try { return JSON.parse(td.decode(await gcmDecrypt(vk, blob, `index:${version}`))); } catch { throw new NotesCryptoError("Your notes index could not be opened.", "BAD_INDEX"); }
}

// ------------------------------------------------------------------------------------------------------- note keys
export const newNoteKeyRaw = () => rnd(32);
export const importNoteKey = (raw) => aesKey(raw, ["encrypt", "decrypt"], true);
const keyAad = (noteId, keyVersion, email) => `${noteId}:${keyVersion}:${String(email).toLowerCase()}`;

/** Seal a note key to one participant. Returns the envelope the server stores. */
export async function sealNoteKey(recipientPublicKeyJwk, rawKey, noteId, keyVersion, recipientEmail) {
  if (!isValidPublicKeyJwk(recipientPublicKeyJwk)) throw new NotesCryptoError("That person's key is not valid.", "BAD_KEY");
  return sealBytes(recipientPublicKeyJwk, rawKey, te.encode(keyAad(noteId, keyVersion, recipientEmail)), INFO);
}
export async function openNoteKey(privateKey, envelope, noteId, keyVersion, myEmail) {
  try { return await importNoteKey(await openSealedBytes(privateKey, envelope, te.encode(keyAad(noteId, keyVersion, myEmail)), INFO)); }
  catch { throw new NotesCryptoError("A note key could not be opened.", "BAD_NOTE_KEY"); }
}
export const exportNoteKey = async (key) => new Uint8Array(await subtle().exportKey("raw", key));

// -------------------------------------------------------------------------------------------------------- revisions
export async function encryptRevision(noteKey, payload, { noteId, rev, keyVersion }) {
  const bytes = te.encode(JSON.stringify(payload));
  if (bytes.length > 60_000) throw new NotesCryptoError("This note is too large (limit about 60 KB of text).", "TOO_LARGE");
  return gcmEncrypt(noteKey, bytes, `${noteId}:${rev}:${keyVersion}`);
}
export async function decryptRevision(noteKey, blob, { noteId, rev, keyVersion }) {
  try { return JSON.parse(td.decode(await gcmDecrypt(noteKey, blob, `${noteId}:${rev}:${keyVersion}`))); }
  catch { throw new NotesCryptoError("This version could not be opened. It may have been altered.", "BAD_REVISION"); }
}
export const newNoteId = () => [...rnd(12)].map((x) => x.toString(16).padStart(2, "0")).join("");
