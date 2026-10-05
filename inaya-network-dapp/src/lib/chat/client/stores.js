// src/lib/chat/client/stores.js
//
// Where a device keeps its chat secrets and decrypted cache. Everything is sealed (AES-256-GCM) before it reaches the raw
// store, so an at-rest copy of the raw store (IndexedDB, files, a backup) is useless without the wrapping key:
//   web      -> IndexedDB, wrapping key is a non-extractable WebCrypto key held in IndexedDB (cannot be exported by script)
//   mobile   -> app sandbox file/MMKV, wrapping key in expo-secure-store behind a biometric/PIN gate (never AsyncStorage)
//   desktop  -> same as web inside the webview, optionally with a key from the OS credential store
//   tests    -> MemoryStore
// Nothing here talks to the server.

const enc = new TextEncoder(); const dec = new TextDecoder();

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async set(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async keys(prefix = "") { return [...this.m.keys()].filter((k) => k.startsWith(prefix)); }
  async clear() { this.m.clear(); }
}

/** AES-256-GCM sealer from raw 32 bytes (mobile/desktop) or from an existing CryptoKey (web, non-extractable). */
export async function createSealer(keyOrBytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("WebCrypto is not available; supply a noble-based sealer on this runtime.");
  const key = keyOrBytes instanceof Uint8Array
    ? await subtle.importKey("raw", keyOrBytes, "AES-GCM", false, ["encrypt", "decrypt"])
    : keyOrBytes;
  return {
    async seal(bytes) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
      const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12); return out;
    },
    async open(bytes) {
      if (bytes.length < 28) throw new Error("Sealed value is too short.");
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
    },
  };
}

export async function generateWrapKey(subtle = globalThis.crypto?.subtle) {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); // extractable:false
}

/** JSON values in, sealed bytes (base64 text) out to the raw store. Key names are not secret; values are. */
export class SealedStore {
  constructor(raw, sealer) { this.raw = raw; this.sealer = sealer; }
  async get(k) {
    const v = await this.raw.get(k);
    if (v == null) return null;
    return JSON.parse(dec.decode(await this.sealer.open(typeof v === "string" ? new Uint8Array(Buffer.from(v, "base64")) : v)));
  }
  async set(k, value) {
    const sealed = await this.sealer.seal(enc.encode(JSON.stringify(value)));
    await this.raw.set(k, typeof Buffer !== "undefined" ? Buffer.from(sealed).toString("base64") : sealed);
  }
  async delete(k) { return this.raw.delete(k); }
  async keys(p) { return this.raw.keys(p); }
  async clear() { return this.raw.clear(); }
}

/** Browser IndexedDB raw store + non-extractable wrapping key. Call only in a browser. */
export async function openBrowserStore(name) {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(`inaya-chat:${name}`, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("keys"); };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); resolve(d); }; // let another tab upgrade or delete the database
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("Secure Chat storage is busy in another Inaya tab. Close the other tabs and reload."));
    setTimeout(() => reject(new Error("Secure Chat storage did not open. Close other Inaya tabs and reload.")), 15000);
  });
  const tx = (store, mode, fn) => new Promise((resolve, reject) => { const t = db.transaction(store, mode); const o = t.objectStore(store); const req = fn(o); t.oncomplete = () => resolve(req?.result); t.onerror = () => reject(t.error); });
  let wrap = await tx("keys", "readonly", (o) => o.get("wrap"));
  if (!wrap) { wrap = await generateWrapKey(); await tx("keys", "readwrite", (o) => o.put(wrap, "wrap")); }
  const raw = {
    get: (k) => tx("kv", "readonly", (o) => o.get(k)).then((v) => v ?? null),
    set: (k, v) => tx("kv", "readwrite", (o) => o.put(v, k)),
    delete: (k) => tx("kv", "readwrite", (o) => o.delete(k)),
    keys: async (p = "") => (await tx("kv", "readonly", (o) => o.getAllKeys())).filter((k) => String(k).startsWith(p)),
    clear: () => tx("kv", "readwrite", (o) => o.clear()),
  };
  return new SealedStore(raw, await createSealer(wrap));
}
