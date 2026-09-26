"use client";

// Browser side of chunked uploads (see src/lib/support/uploads.js). Works for files up to the organization's limit
// (at most 25 MB) even though one request can carry only about 4 MB.

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function json(res) { const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `Upload failed (${res.status}).`); return d; }

/**
 * uploadFile({ file, initUrl, chunkUrl(id, i), completeUrl(id), headers, target, onProgress })
 * target = { ticketId, messageId?, internal? } or { ideaId }. Returns the server's attachment result.
 */
export async function uploadFile({ file, initUrl, chunkUrl, completeUrl, headers = {}, target, onProgress }) {
  let checksum = null;
  try { if (globalThis.crypto?.subtle) checksum = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())); } catch { checksum = null; }
  const init = await json(await fetch(initUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ ...target, filename: file.name, size: file.size, ...(checksum ? { sha256: checksum } : {}) }) }));
  for (let i = 0; i < init.chunks; i++) {
    const part = file.slice(i * init.chunkBytes, Math.min(file.size, (i + 1) * init.chunkBytes));
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await json(await fetch(chunkUrl(init.uploadId, i), { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", ...headers }, body: part })); lastErr = null; break; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); }
    }
    if (lastErr) throw lastErr;
    onProgress?.(Math.round(((i + 1) / init.chunks) * 90));
  }
  onProgress?.(95);
  const done = await json(await fetch(completeUrl(init.uploadId), { method: "POST", credentials: "same-origin", headers: { ...headers } }));
  onProgress?.(100);
  return done;
}
