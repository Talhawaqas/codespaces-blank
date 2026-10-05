// src/components/viewer/decrypt.js -- browser-side helpers shared by every viewer entry point (share links, data rooms, workspace preview).
// The passkey and the readable file never leave this browser; Inaya only ever relays the encrypted shards.

/** The workspace's document format: base64( salt(16) | iv(12) | AES-256-GCM ciphertext ) of a data: URL, key from PBKDF2(passkey). */
export async function decryptData(base64Str, password) {
  const binaryStr = window.atob(base64Str);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) combined[i] = binaryStr.charCodeAt(i);
  const salt = combined.slice(0, 16); const iv = combined.slice(16, 28); const encrypted = combined.slice(28);
  const keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted));
}

/** data:<mime>;base64,<payload> -> { bytes, mime } */
export function dataUrlToFile(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,/.exec(dataUrl); if (!m) throw new Error("The decrypted content is not a file.");
  const payload = dataUrl.slice(m[0].length);
  const bin = m[2] ? window.atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] || "application/octet-stream" };
}
