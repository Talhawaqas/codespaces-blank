// public/pos-offline-sw.js -- Inaya Commerce, offline selling: keeps the offline till page (/business/pos-offline) on the
// till so it opens with no internet (for example after the computer or the Inaya app restarts during an outage).
//
// Registered ONLY with scope /business/pos-offline, so it controls that one page and nothing else on the site. It stores
// that page's HTML (a static page: no personal data) and the script/style files it needs. Sales and prices are NOT kept
// here: they stay encrypted in the till's own store (offlineStore.js). API requests are never cached.
const CACHE = "inaya-pos-offline-v1";
const PAGE = "/business/pos-offline";
const MAX_FILES = 400;

self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(warm()); });
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("inaya-pos-offline-") && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("message", (e) => { if (e.data === "warm") e.waitUntil(warm()); });

const staticUrls = (text) => [...new Set((text.match(/\/_next\/static\/[^"'\s)\\]+/g) || []))];

/** Fetches the page fresh and stores it with every file it lists (and the fonts its stylesheets use). */
async function warm() {
  try { const r = await fetch(PAGE, { cache: "no-store", credentials: "same-origin" }); if (r.ok && !r.redirected) await store(r); } catch { /* offline: keep what we have */ }
}
async function store(resp) {
  const c = await caches.open(CACHE);
  const html = await resp.clone().text();
  await c.put(PAGE, resp);
  const files = staticUrls(html);
  for (const u of files) {
    let hit = await c.match(u);
    if (!hit) { try { const x = await fetch(u); if (x.ok) { await c.put(u, x.clone()); hit = x; } } catch { /* next time */ } }
    if (hit && /\.css(\?|$)/.test(u)) { try { for (const f of staticUrls(await hit.clone().text())) if (!(await c.match(f))) { const y = await fetch(f); if (y.ok) await c.put(f, y); } } catch { /* fonts are optional */ } }
  }
  const keys = await c.keys(); // oldest first: trim old builds' files beyond the cap
  for (let i = 0; i < keys.length - MAX_FILES; i++) if (new URL(keys[i].url).pathname !== PAGE) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && url.pathname === PAGE) { // fresh when online, the stored copy when not
    e.respondWith((async () => {
      try { const r = await fetch(req); if (r.ok && !r.redirected) e.waitUntil(store(r.clone())); return r; }
      catch { const hit = await (await caches.open(CACHE)).match(PAGE); return hit || new Response("This till has no offline copy yet. Open Point of Sale once while online.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    })());
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) { // build files never change once published: stored copy first
    e.respondWith((async () => {
      const c = await caches.open(CACHE); const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r.ok) e.waitUntil(c.put(req, r.clone())); return r;
    })());
  }
});
