// src/lib/commerce/offlineStore.js -- Inaya Commerce, offline selling: the till's encrypted on-device store (browser only).
//
// Everything is kept in IndexedDB, encrypted with AES-GCM-256 under a key generated on this device as NON-EXTRACTABLE
// (the browser can use it but nothing, not even this code, can read the key out). Stored: the till's offline pack (products,
// prices, limits, its signing secret) and the queue of offline sales waiting to sync. Each sale is signed with HMAC-SHA256
// using the pack secret (offlinePricing.canonicalOfflineSale), so the server can tell if a queued sale was altered.
// Receipt numbers come from a per-pack counter stored with the pack and advanced under a Web Lock, so two windows on the
// same till can't hand out the same number.
import { canonicalOfflineSale } from "./offlinePricing";

const DB = "inaya-pos-offline"; const STORE = "kv"; const KEY_ID = "aes-key";
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(mode, fn) { const db = await idb(); try { return await new Promise((res, rej) => { const t = db.transaction(STORE, mode); const st = t.objectStore(STORE); let out; Promise.resolve(fn(st, (v) => { out = v; })).catch(rej); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); } finally { db.close(); } }
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const rawGet = (k) => tx("readonly", async (st, set) => set(await req(st.get(k))));
const rawPut = (k, v) => tx("readwrite", (st) => { st.put(v, k); });
const rawDel = (k) => tx("readwrite", (st) => { st.delete(k); });
const rawKeys = (prefix) => tx("readonly", async (st, set) => set((await req(st.getAllKeys())).filter((k) => typeof k === "string" && k.startsWith(prefix))));

export const offlineSupported = () => typeof window !== "undefined" && !!window.indexedDB && !!window.crypto?.subtle;

let keyP = null;
async function aesKey() {
  if (keyP) return keyP;
  keyP = (async () => {
    const k = await rawGet(KEY_ID); if (k) return k;
    const nk = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await rawPut(KEY_ID, nk); return nk;
  })().catch((e) => { keyP = null; throw e; });
  return keyP;
}
async function putSecure(k, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(JSON.stringify(obj)));
  await rawPut(k, { iv, ct });
}
async function getSecure(k) {
  const v = await rawGet(k); if (!v) return null;
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: v.iv }, await aesKey(), v.ct))); }
  catch { return null; } // unreadable (key lost or data altered): treated as absent, never used
}
const withLock = (name, fn) => (typeof navigator !== "undefined" && navigator.locks?.request ? navigator.locks.request(name, fn) : fn());

const packKey = (orgId, registerId) => `pack:${orgId}:${registerId}`;
const qPrefix = (orgId) => `q:${orgId}:`;

/** The till this computer sells offline for (ids only, no secrets): read by the offline till page. */
const TILL_KEY = "inaya_pos_offline_till";
export function lastTill() { try { const v = JSON.parse(localStorage.getItem(TILL_KEY) || "null"); return v?.orgId && v?.registerId ? v : null; } catch { return null; } }
function rememberTill(orgId, registerId) { try { localStorage.setItem(TILL_KEY, JSON.stringify({ orgId: String(orgId), registerId: String(registerId) })); } catch { /* storage blocked */ } }

/** Keeps the offline till page (/business/pos-offline) on this computer so it opens without internet. */
export async function keepOfflinePageReady() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return false;
  try { const reg = await navigator.serviceWorker.register("/pos-offline-sw.js", { scope: "/business/pos-offline" }); (reg.active || reg.waiting || reg.installing)?.postMessage?.("warm"); return true; } catch { return false; }
}

export async function savePack(orgId, pack) {
  rememberTill(orgId, pack.registerId);
  return withLock(`inaya-pos-pack-${orgId}-${pack.registerId}`, async () => {
    const old = await getSecure(packKey(orgId, pack.registerId));
    // keep the old pack's counter only if it is the same pack; a new pack starts at 1 with its own prefix
    await putSecure(packKey(orgId, pack.registerId), { ...pack, nextSeq: old?.packId === pack.packId ? old.nextSeq : 1, savedAt: new Date().toISOString() });
    if (old && old.packId !== pack.packId) await putSecure(`oldpack:${orgId}:${old.packId}`, { packId: old.packId, secret: old.secret, expiresAt: old.expiresAt });
  });
}
export const loadPack = (orgId, registerId) => (registerId ? getSecure(packKey(orgId, registerId)) : Promise.resolve(null));

/** Why a pack can't sell right now (or null when it can). */
export function packProblem(pack, now = Date.now()) {
  if (!pack) return "This till hasn't downloaded its offline price list yet (it does this automatically while online with a shift open).";
  if (Date.parse(pack.expiresAt) < now) return "This till's offline period has ended. Reconnect to continue selling.";
  if ((pack.nextSeq || 1) > pack.maxSales) return `This till has reached its limit of ${pack.maxSales} offline sales. Reconnect to continue.`;
  return null;
}

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function sign(secret, sale) {
  const k = await crypto.subtle.importKey("raw", fromB64u(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(canonicalOfflineSale(sale))));
}
export const newOfflineId = () => `off_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Takes the next receipt number, signs the sale and stores it in the queue -- one locked step, so a number is never reused
 *  and a sale is never numbered without being saved. Returns the queued sale. */
export async function queueOfflineSale(orgId, registerId, { offlineId, lines, cashMinor, totalMinor, notes, drawerOpened = false }) {
  return withLock(`inaya-pos-pack-${orgId}-${registerId}`, async () => {
    const pack = await getSecure(packKey(orgId, registerId)); const problem = packProblem(pack); if (problem) throw new Error(problem);
    const seq = pack.nextSeq || 1;
    const sale = { offlineId: offlineId || newOfflineId(), packId: pack.packId, seq, receiptNumber: `${pack.receiptPrefix}-${String(seq).padStart(4, "0")}`, createdAt: new Date().toISOString(),
      lines: lines.map((l) => ({ productId: String(l.productId), quantity: Number(l.quantity) })), cashMinor, totalMinor, notes: notes || "", drawerOpened: drawerOpened === true, tenders: [{ method: "CASH" }], registerId, warehouseId: pack.warehouseId };
    sale.signature = await sign(pack.secret, sale);
    await putSecure(packKey(orgId, registerId), { ...pack, nextSeq: seq + 1 }); // the counter first: a crash in between can only skip a number, never re-use one
    await putSecure(`${qPrefix(orgId)}${sale.offlineId}`, sale);
    return sale;
  });
}
export async function listQueue(orgId) { const keys = await rawKeys(qPrefix(orgId)); const out = []; for (const k of keys) { const v = await getSecure(k); if (v) out.push(v); } return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
export async function queueCount(orgId) { try { return (await rawKeys(qPrefix(orgId))).length; } catch { return 0; } }
export const removeFromQueue = (orgId, offlineId) => rawDel(`${qPrefix(orgId)}${offlineId}`);

/** Sends the queue to the server in batches per pack; removes every sale the server answered (recorded, already recorded,
 *  or sent to the manager). Network failures leave the queue untouched. */
export async function syncQueue(orgId, post) {
  const q = await listQueue(orgId); if (!q.length) return { sent: 0, recorded: 0, rejected: 0, left: 0 };
  const groups = new Map(); for (const s of q) groups.set(s.packId, [...(groups.get(s.packId) || []), s]);
  let recorded = 0, rejected = 0, sent = 0; const rejections = [];
  for (const [packId, sales] of groups) {
    for (let i = 0; i < sales.length; i += 20) {
      const batch = sales.slice(i, i + 20);
      const r = await post({ packId, registerId: batch[0].registerId, warehouseId: batch[0].warehouseId, sales: batch });
      for (const x of r.results || []) {
        if (["RECORDED", "DUPLICATE", "REJECTED"].includes(x.status)) { await removeFromQueue(orgId, x.offlineId); sent++; }
        if (x.status === "REJECTED") { rejected++; rejections.push(x); } else recorded++;
      }
      if (r.pending) return { sent, recorded, rejected, rejections, left: await queueCount(orgId) }; // server ran out of time: the rest go on the next round
    }
  }
  return { sent, recorded, rejected, rejections, left: await queueCount(orgId) };
}
