// src/lib/chunkedFile.js
//
// The Business Workspace's chunked document format ("inaya-chunked" v1, 16 Nov 2026), used for files
// above CHUNKED_THRESHOLD_BYTES. Smaller files keep the original format (one base64 data URL,
// AES-GCM encrypted, split at its midpoint into two pinned shards) unchanged.
//
// Why a second format: the original one holds the whole file in memory as base64 text and sends each
// half through our server, so files over ~5 MB failed (the server function's request limit) and the
// browser's string limit capped it below ~1 GB. Here:
//   - the key is derived exactly as before: PBKDF2(passkey, random 16-byte salt, 100,000, SHA-256) -> AES-256-GCM;
//   - the file is read in PIECE_SIZE slices; each piece is encrypted on its own with a random 12-byte IV
//     and additional data binding it to its upload, position and piece count (so pieces can't be
//     reordered, dropped or mixed between files without decryption failing);
//   - each encrypted piece (iv | ciphertext) is split at its midpoint into an alpha half and a beta half,
//     keeping the "no single shard is the file" property: the alpha manifest lists only alpha halves and
//     the beta manifest only beta halves;
//   - the browser uploads every half straight to storage through short-lived signed links (no file bytes
//     pass through our server), and the two small JSON manifests become the document's cidAlpha / cidBeta.
// The file's type travels inside an encrypted header, so the manifests reveal only sizes and counts.
//
// Isomorphic: uses globalThis.crypto.subtle (browsers, and Node 20+ for the tests). No storage or
// network code here; uploads and downloads take injected functions.

export const FORMAT = "inaya-chunked";
export const FORMAT_VERSION = 1;
export const PIECE_SIZE = 16 * 1024 * 1024;
// Files at or below this keep the original format (its shards stay under the server's request limit).
export const CHUNKED_THRESHOLD_BYTES = 3.5 * 1024 * 1024;
const PBKDF2_ITERATIONS = 100000;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("This browser cannot encrypt files (Web Crypto is unavailable).");
  return s;
};
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256HexBytes(bytes) { return hex(await subtle().digest("SHA-256", bytes)); }

export function pieceCount(sizeBytes, pieceSize = PIECE_SIZE) { return Math.max(1, Math.ceil(sizeBytes / pieceSize)); }
export function isChunkedManifest(obj) { return !!obj && obj.format === FORMAT && Array.isArray(obj.pieces); }

export async function deriveKey(passkey, salt) {
  const material = await subtle().importKey("raw", enc.encode(passkey), { name: "PBKDF2" }, false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const aadFor = (uploadId, index, count) => enc.encode(`${FORMAT}/${FORMAT_VERSION}|${uploadId}|${index}|${count}`);

/** Encrypts one piece: returns iv(12) | AES-GCM ciphertext (with tag). index -1 is the encrypted header. */
export async function encryptPiece(key, plain, { uploadId, index, count }) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aadFor(uploadId, index, count) }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}

export async function decryptPiece(key, blob, { uploadId, index, count }) {
  if (blob.length < 28) throw new Error("A piece of this file is damaged.");
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: aadFor(uploadId, index, count) }, key, blob.subarray(12)));
  } catch {
    throw new Error(index < 0 ? "Could not decrypt this document. Check the passkey and try again." : "A piece of this file failed its integrity check.");
  }
}

export const splitHalves = (blob) => { const mid = Math.floor(blob.length / 2); return [blob.subarray(0, mid), blob.subarray(mid)]; };

/** fileHash for the on-chain record: SHA-256 over the upload id and every encrypted piece's own SHA-256, in order. */
export async function chunkedFileHash(uploadId, pieceHashes) {
  return "0x" + (await sha256HexBytes(enc.encode(`${FORMAT}/${FORMAT_VERSION}|${uploadId}|${pieceHashes.join(",")}`)));
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await worker(items[i], i); }
  });
  await Promise.all(runners);
}

/**
 * Encrypts and uploads a large file. Transport is injected:
 *   start()                  -> { uploadId, token, pieceSize }
 *   sign(token, from, count) -> [{ index, alpha: { key, url }, beta: { key, url } }]
 *   signManifests(token)     -> { alpha: { key, url }, beta: { key, url } }
 *   put(url, bytes, type)    -> cid (the storage provider's IPFS CID for that object)
 * Returns what the document registration needs: { fileHash, sizeBytes, cidAlpha, cidBeta, chunkedUploadToken }.
 */
export async function uploadChunkedFile(file, passkey, { start, sign, signManifests, put, onProgress = () => {}, concurrency = 3, signBatch = 32 }) {
  if (!passkey) throw new Error("A passkey is required.");
  const { uploadId, token, pieceSize = PIECE_SIZE } = await start();
  const count = pieceCount(file.size, pieceSize);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passkey, salt);
  const header = await encryptPiece(key, enc.encode(JSON.stringify({ type: file.type || "application/octet-stream" })), { uploadId, index: -1, count });

  const alpha = new Array(count);
  const beta = new Array(count);
  const hashes = new Array(count);
  let done = 0;
  for (let from = 0; from < count; from += signBatch) {
    const urls = await sign(token, from, Math.min(signBatch, count - from));
    await runPool(urls, concurrency, async (u) => {
      const i = u.index;
      const plain = new Uint8Array(await file.slice(i * pieceSize, Math.min(file.size, (i + 1) * pieceSize)).arrayBuffer());
      const blob = await encryptPiece(key, plain, { uploadId, index: i, count });
      hashes[i] = await sha256HexBytes(blob);
      const [a, b] = splitHalves(blob);
      const [cidA, cidB] = await Promise.all([put(u.alpha.url, a, "application/octet-stream"), put(u.beta.url, b, "application/octet-stream")]);
      alpha[i] = { index: i, key: u.alpha.key, cid: cidA, bytes: a.length };
      beta[i] = { index: i, key: u.beta.key, cid: cidB, bytes: b.length };
      done += 1;
      onProgress({ done, count });
    });
  }

  const base = { format: FORMAT, version: FORMAT_VERSION, uploadId, pieceSize, size: file.size, count, salt: toBase64(salt) };
  const manifestUrls = await signManifests(token);
  const alphaManifest = { ...base, role: "alpha", header: toBase64(header), pieces: alpha };
  const betaManifest = { ...base, role: "beta", pieces: beta };
  const [cidAlpha, cidBeta] = await Promise.all([
    put(manifestUrls.alpha.url, enc.encode(JSON.stringify(alphaManifest)), "application/json"),
    put(manifestUrls.beta.url, enc.encode(JSON.stringify(betaManifest)), "application/json"),
  ]);
  return { fileHash: await chunkedFileHash(uploadId, hashes), sizeBytes: file.size, cidAlpha, cidBeta, chunkedUploadToken: token };
}

/** Checks two manifests belong together and are complete. */
export function checkManifestPair(alpha, beta) {
  if (!isChunkedManifest(alpha) || !isChunkedManifest(beta)) throw new Error("This file's storage records are not readable.");
  if (alpha.version !== FORMAT_VERSION || beta.version !== FORMAT_VERSION) throw new Error("This file was stored in a newer format. Update the app to open it.");
  if (alpha.uploadId !== beta.uploadId || alpha.count !== beta.count || alpha.salt !== beta.salt || alpha.role !== "alpha" || beta.role !== "beta") throw new Error("This file's storage records do not match.");
  if (alpha.pieces.length !== alpha.count || beta.pieces.length !== beta.count) throw new Error("This file's storage records are incomplete.");
}

/**
 * Decrypts a chunked file piece by piece. getBytes(piece) fetches one half (piece.url is a signed link).
 * onPiece(plainBytes, index) receives the decrypted pieces in order. Returns { type, size }.
 */
export async function openChunkedFile(alpha, beta, passkey, { getBytes, onPiece, onProgress = () => {}, concurrency = 3 }) {
  checkManifestPair(alpha, beta);
  const { uploadId, count } = alpha;
  const key = await deriveKey(passkey, fromBase64(alpha.salt));
  const meta = JSON.parse(dec.decode(await decryptPiece(key, fromBase64(alpha.header), { uploadId, index: -1, count })));
  // Fetch ahead with a small window, hand pieces over strictly in order.
  const ready = new Map();
  let nextToEmit = 0;
  let waiter = null;
  const indices = Array.from({ length: count }, (_, i) => i);
  const fetcher = runPool(indices, concurrency, async (i) => {
    while (i - nextToEmit >= concurrency * 2) await new Promise((r) => setTimeout(r, 20)); // bounded memory
    const [a, b] = await Promise.all([getBytes(alpha.pieces[i]), getBytes(beta.pieces[i])]);
    const blob = new Uint8Array(a.length + b.length);
    blob.set(a, 0); blob.set(b, a.length);
    ready.set(i, await decryptPiece(key, blob, { uploadId, index: i, count }));
    if (waiter) { const w = waiter; waiter = null; w(); }
  });
  let failure = null;
  fetcher.catch((e) => { failure = e; if (waiter) { const w = waiter; waiter = null; w(); } });
  while (nextToEmit < count) {
    if (failure) throw failure;
    if (!ready.has(nextToEmit)) { await new Promise((r) => { waiter = r; }); continue; }
    const plain = ready.get(nextToEmit); ready.delete(nextToEmit);
    await onPiece(plain, nextToEmit);
    nextToEmit += 1;
    onProgress({ done: nextToEmit, count });
  }
  await fetcher;
  return { type: meta.type || "application/octet-stream", size: alpha.size };
}
