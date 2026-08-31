"use client";

// src/lib/clientCrypto.js
//
// The client-side encrypt/shard/pin pipeline, consolidated. Before this,
// the exact same four pure functions (encryptData, readFileAsDataURL,
// uploadShardToPinata, sha256Hex) were independently duplicated three
// times — business/page.js's DocumentColumn, FinanceView.js's receipt
// upload, HRView.js's employee-document upload — each copy justified at
// the time by "nothing to import from, they're closures not a module."
// That reasoning no longer holds once the SAME block exists three times:
// one place to verify/fix if the algorithm or pinning endpoint ever
// changes, instead of three that can silently drift apart. Same
// algorithm, same parameters (PBKDF2 100k iterations SHA-256 -> AES-GCM-
// 256, midpoint shard split, dual-gateway Pinata pin) as every call site
// already had — this is a pure extraction, not a behavior change.

export async function encryptData(text, password) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  let binary = "";
  for (let i = 0; i < combined.byteLength; i++) binary += String.fromCharCode(combined[i]);
  return window.btoa(binary);
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function uploadShardToPinata(encryptedShard, filename, elementTag) {
  const res = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ encryptedShard, filename, elementTag }) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || data.pinata || "IPFS pinning failed.");
  return data.IpfsHash;
}

export async function sha256Hex(text) {
  const enc = new TextEncoder();
  const digest = await window.crypto.subtle.digest("SHA-256", enc.encode(text));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The full pipeline in one call — encrypt, hash, split, pin both shards
 *  in parallel. Returns exactly the fields every call site needs to POST
 *  to its own metadata-recording route: {fileHash, sizeBytes, cidAlpha,
 *  cidBeta}. sizeBytes is the ORIGINAL file's size (what every existing
 *  call site records), not the encrypted/shard size. */
export async function encryptAndShardFile(file, passkey) {
  const dataUrl = await readFileAsDataURL(file);
  const cipherText = await encryptData(dataUrl, passkey);
  const fileHash = await sha256Hex(cipherText);
  const midpoint = Math.ceil(cipherText.length / 2);
  const [cidAlpha, cidBeta] = await Promise.all([
    uploadShardToPinata(cipherText.slice(0, midpoint), file.name, "Alpha"),
    uploadShardToPinata(cipherText.slice(midpoint), file.name, "Beta"),
  ]);
  return { fileHash, sizeBytes: file.size, cidAlpha, cidBeta };
}
