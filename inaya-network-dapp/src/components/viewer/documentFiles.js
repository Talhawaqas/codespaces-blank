"use client";
// src/components/viewer/documentFiles.js -- browser-side upload and opening of Business Workspace documents in
// either storage format:
//   - the original one (files up to CHUNKED_THRESHOLD_BYTES): two base64 shards, unchanged (clientCrypto.js / decrypt.js);
//   - the chunked one for large files (src/lib/chunkedFile.js): encrypted pieces uploaded straight to storage
//     through signed links, read back the same way.
// The passkey and the readable file never leave this browser.

import { encryptAndShardFile } from "../../lib/clientCrypto";
import { CHUNKED_THRESHOLD_BYTES, isChunkedManifest, openChunkedFile, uploadChunkedFile } from "../../lib/chunkedFile";
import { dataUrlToFile, decryptData } from "./decrypt";

async function post(body) {
  const res = await fetch("/api/orgs/uploads/chunked", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload request failed (${res.status}).`);
  return data;
}

async function putPiece(url, bytes, type, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: bytes, headers: { "Content-Type": type } });
      if (!res.ok) throw new Error(`Storage refused a piece (${res.status}).`);
      const cid = res.headers.get("x-amz-meta-cid");
      if (!cid) throw new Error("Storage did not confirm a piece.");
      return cid;
    } catch (err) {
      if (attempt >= attempts) throw new Error(`Uploading failed: ${err.message} Check your connection and try again.`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Encrypts and uploads a document file; returns the fields POST /api/orgs/documents needs
 *  ({ fileHash, sizeBytes, cidAlpha, cidBeta } plus chunkedUploadToken for large files). */
export async function uploadDocumentFile(file, passkey, { orgId, onProgress = () => {} } = {}) {
  if (file.size <= CHUNKED_THRESHOLD_BYTES) return encryptAndShardFile(file, passkey);
  let token = null;
  try {
    return await uploadChunkedFile(file, passkey, {
      start: async () => { const s = await post({ action: "start", orgId, sizeBytes: file.size }); token = s.token; return s; },
      sign: async (t, from, count) => (await post({ action: "sign", orgId, token: t, from, count })).pieces,
      signManifests: (t) => post({ action: "manifests", orgId, token: t }),
      put: putPiece,
      onProgress,
    });
  } catch (err) {
    if (token) post({ action: "abort", orgId, token }).catch(() => {}); // remove the pieces that did arrive
    throw err;
  }
}

/** If a registration fails after a chunked upload, remove what was stored. */
export function abandonChunkedUpload(orgId, token) {
  if (token) post({ action: "abort", orgId, token }).catch(() => {});
}

/** A shard-content string from a share / data-room content route: the original format's shard text, or a chunked manifest. */
export function parseShardContent(content) {
  const obj = typeof content === "string" ? JSON.parse(content) : content;
  return isChunkedManifest(obj) ? obj : obj.shard;
}

async function fetchBytes(piece) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(piece.url);
      if (!res.ok) throw new Error(`(${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`A piece of this file could not be downloaded ${err.message}. Try again.`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Decrypts either format into a Blob. alpha/beta: the original format's two shard strings, or two chunked manifests. */
export async function decryptToBlob(alpha, beta, passkey, { onProgress } = {}) {
  if (isChunkedManifest(alpha)) {
    const parts = [];
    const { type } = await openChunkedFile(alpha, beta, passkey, { getBytes: fetchBytes, onPiece: (p) => { parts.push(p); }, onProgress });
    return new Blob(parts, { type });
  }
  let dataUrl;
  try { dataUrl = await decryptData(alpha + beta, passkey); } catch { throw new Error("Could not decrypt this document. Check the passkey and try again."); }
  const { bytes, mime } = dataUrlToFile(dataUrl);
  return new Blob([bytes], { type: mime });
}

/** { bytes, mime } for the in-browser viewers (share links, data rooms, workspace preview). */
export async function decryptToFile(alpha, beta, passkey, opts) {
  const blob = await decryptToBlob(alpha, beta, passkey, opts);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "application/octet-stream" };
}

/** Saves a document to the user's disk. Large chunked files are written piece by piece where the browser
 *  supports it (Chrome, Edge), so a multi-gigabyte file never has to fit in memory. */
export async function saveDocument(alpha, beta, passkey, filename, { onProgress } = {}) {
  if (isChunkedManifest(alpha) && typeof window !== "undefined" && window.showSaveFilePicker && alpha.size > 256 * 1024 * 1024) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: filename }); } catch (err) { if (err?.name === "AbortError") return { cancelled: true }; throw err; }
    const writable = await handle.createWritable();
    try {
      await openChunkedFile(alpha, beta, passkey, { getBytes: fetchBytes, onPiece: (p) => writable.write(p), onProgress });
      await writable.close();
    } catch (err) { await writable.abort().catch(() => {}); throw err; }
    return { saved: true };
  }
  const blob = await decryptToBlob(alpha, beta, passkey, { onProgress });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { saved: true };
}
