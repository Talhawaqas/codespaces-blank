// src/transfer.js -- end-to-end encrypted, resumable transfer of an approved file to Inaya, and restore from it.
//   * The file is encrypted HERE with a fresh AES-256-GCM key (blob = iv | ciphertext | tag) and cut into fixed 1 MB parts.
//   * The file key is wrapped with the gateway's data key (kept in the passphrase-protected local config). The wrapped key is sent as an opaque envelope.
//     Inaya never holds anything that can open it.
//   * Each part is sent with its SHA-256. Asking Inaya which parts it holds makes an interrupted transfer resume instead of restart.
//   * The finish call carries a chain hash over all part hashes, which Inaya recomputes from what it stored.
//   * Bandwidth is capped with a token bucket.
import { randomBytes, createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import fs from "node:fs";
import { resolveInside } from "./connectors.js";

export const PART_BYTES = 1024 * 1024;
const sha = (b) => createHash("sha256").update(b).digest("hex");
export const chainHashOf = (hashes) => sha(hashes.map((h, i) => `${i}:${h}`).join("\n"));

export function wrapKey(fileKey, dataKey) { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", dataKey, iv); const ct = Buffer.concat([c.update(fileKey), c.final()]); return JSON.stringify({ v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") }); }
export function unwrapKey(envelope, dataKey) { const j = JSON.parse(envelope); const d = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(j.iv, "base64")); d.setAuthTag(Buffer.from(j.tag, "base64")); return Buffer.concat([d.update(Buffer.from(j.ct, "base64")), d.final()]); }

/** The file key and nonce are derived from the data key, the transfer id and the file's own hash, so re-encrypting after an interruption yields the SAME bytes
 *  and parts already stored stay valid. Each (transfer, content) pair gets its own key, so a nonce is never reused under one key. */
export function encryptFile(bytes, dataKey, transferId = "local") {
  const plainHash = sha(bytes); const okm = Buffer.from(hkdfSync("sha256", dataKey, Buffer.from(plainHash, "hex"), Buffer.from(`inaya-gateway-file:${transferId}`), 44)); const fileKey = okm.subarray(0, 32), iv = okm.subarray(32, 44); const c = createCipheriv("aes-256-gcm", fileKey, iv); const ct = Buffer.concat([c.update(bytes), c.final()]);
  const blob = Buffer.concat([iv, ct, c.getAuthTag()]); const parts = []; for (let o = 0; o < blob.length; o += PART_BYTES) parts.push(blob.subarray(o, o + PART_BYTES));
  return { parts, cipherSize: blob.length, envelope: wrapKey(fileKey, dataKey), plainSha256: sha(bytes) };
}
export function decryptBlob(blob, envelope, dataKey) {
  const key = unwrapKey(envelope, dataKey); const iv = blob.subarray(0, 12), tag = blob.subarray(blob.length - 16), ct = blob.subarray(12, blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]);
}

/** Token bucket. `take(n)` resolves when n bytes may be sent. kbps = 0 means unlimited. Time and sleep are injectable for tests. */
export function makeThrottle({ kbps = 0, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const rate = (kbps * 1024) / 1000; let allowance = rate * 1000; let last = now();
  return { async take(n) { if (!rate) return 0; let waited = 0; for (;;) { const t = now(); allowance = Math.min(rate * 1000, allowance + (t - last) * rate); last = t; if (allowance >= n) { allowance -= n; return waited; } const need = Math.ceil((n - allowance) / rate); waited += need; await sleep(need); } } };
}

/** Sends the file for one transfer. Safe to call again after any interruption (`hooks.afterPart` lets tests simulate a dropped connection). */
export async function uploadTransfer({ client, transfer, rootPath, folderPath, dataKey, throttle = makeThrottle(), hooks = {} }) {
  const full = resolveInside(resolveInside(rootPath, folderPath), transfer.path); const bytes = fs.readFileSync(full); const enc = encryptFile(bytes, dataKey, transfer.transferId);
  const begin = await client.post(`/api/gateway/v1/transfers/${transfer.transferId}/begin`, { partCount: enc.parts.length, cipherSize: enc.cipherSize, keyEnvelope: enc.envelope, plainSha256: enc.plainSha256 });
  const { sent, chainHash } = await sendParts({ client, transferId: transfer.transferId, enc, held: begin.received, throttle, hooks });
  await client.post(`/api/gateway/v1/transfers/${transfer.transferId}/complete`, { chainHash });
  return { sent, parts: enc.parts.length, resumedFrom: begin.received.length, size: bytes.length };
}
export async function sendParts({ client, transferId, enc, held = [], throttle = makeThrottle(), hooks = {} }) {
  const have = new Set(held); let sent = 0;
  for (let i = 0; i < enc.parts.length; i++) {
    if (have.has(i)) continue; const p = enc.parts[i]; await throttle.take(p.length);
    await client.put(`/api/gateway/v1/transfers/${transferId}/parts/${i}`, { data: p.toString("base64"), sha256: sha(p) }); sent++; if (hooks.afterPart) await hooks.afterPart(i);
  }
  return { sent, chainHash: chainHashOf(enc.parts.map(sha)) };
}

/** Restores a completed transfer: reads the parts back from Inaya, verifies each hash, decrypts locally. */
export async function restoreTransfer({ client, transferId, dataKey }) {
  const st = await client.get(`/api/gateway/v1/transfers/${transferId}`); if (st.status !== "complete" || !st.keyEnvelope) throw new Error(`The transfer is ${st.status}, not complete.`);
  const chunks = []; for (let i = 0; i < st.partCount; i++) { const p = await client.get(`/api/gateway/v1/transfers/${transferId}/parts/${i}`); const b = Buffer.from(p.data, "base64"); if (sha(b) !== p.sha256) throw new Error(`Part ${i} failed its hash check.`); chunks.push(b); }
  return decryptBlob(Buffer.concat(chunks), st.keyEnvelope, dataKey);
}
