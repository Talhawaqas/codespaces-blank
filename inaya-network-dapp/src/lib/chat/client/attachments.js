// src/lib/chat/client/attachments.js
//
// Device-side attachment encryption. A file is sealed with a fresh AES-256-GCM key and random nonce (WebCrypto) before any byte
// leaves the device; only ciphertext is uploaded. The returned descriptor (key, nonce, hash, name, type) goes inside the
// end-to-end encrypted chat message, never to the server in any other form.

const PART_BYTES = 1536 * 1024; // keep in step with server chat/attachments.js PART_BYTES
const toB64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
const fromB64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

export async function uploadEncrypted({ api, conversationId, bytes, name, type }) {
  const subtle = globalThis.crypto.subtle;
  const key = crypto.getRandomValues(new Uint8Array(32)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, k, bytes));
  const sha256 = hex(new Uint8Array(await subtle.digest("SHA-256", ct)));
  const partCount = Math.max(1, Math.ceil(ct.length / PART_BYTES));
  const { blobId } = await api.beginAttachment({ conversationId, size: ct.length, partCount });
  for (let i = 0; i < partCount; i++) await api.uploadPart({ conversationId, blobId, index: i, data: toB64(ct.subarray(i * PART_BYTES, (i + 1) * PART_BYTES)) });
  await api.completeAttachment({ conversationId, blobId });
  return { kind: "blob", blobId, key: toB64(key), iv: toB64(iv), size: ct.length, plainSize: bytes.length, partCount, sha256, name: String(name || "file").slice(0, 200), type: String(type || "application/octet-stream").slice(0, 100) };
}

export async function downloadDecrypted({ api, conversationId, descriptor }) {
  const subtle = globalThis.crypto.subtle;
  const out = new Uint8Array(descriptor.size); let off = 0;
  for (let i = 0; i < descriptor.partCount; i++) { const p = await api.readPart({ conversationId, blobId: descriptor.blobId, index: i }); const b = fromB64(p.data); out.set(b, off); off += b.length; }
  if (off !== descriptor.size) throw new Error("The attachment is incomplete.");
  if (hex(new Uint8Array(await subtle.digest("SHA-256", out))) !== descriptor.sha256) throw new Error("The attachment failed its integrity check.");
  const k = await subtle.importKey("raw", fromB64(descriptor.key), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromB64(descriptor.iv) }, k, out)); // throws if tampered
}

/** A reference to a file that already exists in Inaya. No bytes and no key are placed in the chat. */
export const inayaDocRef = ({ documentId, name, size }) => ({ kind: "inaya-doc", documentId: String(documentId), name: String(name || "").slice(0, 200), size: Number(size) || 0 });
