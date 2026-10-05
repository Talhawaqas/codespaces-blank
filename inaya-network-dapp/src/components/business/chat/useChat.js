"use client";

// src/components/business/chat/useChat.js
//
// Browser state for Secure Chat: starts this device's ChatClient (keys and decrypted cache live only in this browser, sealed in
// IndexedDB), runs the sync loop (long poll with backoff, paused while the tab is hidden), and exposes plain data to the view.
// The server only ever sees ciphertext and metadata. See docs/architecture/e2ee-chat-key-management.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { reportMetric } from "./reportMetric.js";

const supported = async () => {
  if (typeof window === "undefined" || !window.crypto?.subtle || !window.indexedDB) return false;
  try { await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]); return true; } catch { return false; }
};

// One ChatClient per (organization, person) per page, even if React mounts the effect twice (StrictMode, hot reload): a second
// start would enroll a second device. The promise is shared and cleared only if starting fails.
const starting = new Map();
async function startClient(orgId, email, onSecurityEvent) {
  const key = orgId + ":" + email;
  if (!starting.has(key)) {
    starting.set(key, (async () => {
      const [{ ChatClient }, { HttpChatApi }, { openBrowserStore }] = await Promise.all([
        import("../../../lib/chat/client/ChatClient.js"), import("../../../lib/chat/client/httpApi.js"), import("../../../lib/chat/client/stores.js"),
      ]);
      const store = await openBrowserStore(key);
      const client = new ChatClient({ api: new HttpChatApi({ orgId }), store, orgId, email, label: "Web browser", platform: "web", jitterMs: 250, onSecurityEvent: (e) => onSecurityEvent.current?.(e) });
      await client.init();
      return client;
    })().catch((err) => { starting.delete(key); throw err; }));
  }
  return starting.get(key);
}

export function useChat({ orgId, email }) {
  const [status, setStatus] = useState("starting"); // starting | ready | unsupported | off | error
  const [error, setError] = useState("");
  const [conversations, setConversations] = useState([]);
  const [titles, setTitles] = useState({});
  const [last, setLast] = useState({});
  const [peers, setPeers] = useState({});
  const [tick, setTick] = useState(0);
  const [securityEvents, setSecurityEvents] = useState([]);
  const clientRef = useRef(null);
  const onEvent = useRef(null);
  onEvent.current = (e) => { if (e?.type === "DECRYPT_FAILED") reportMetric(orgId, "chat.decrypt_failure"); setSecurityEvents((x) => [...x.slice(-19), { ...e, at: new Date().toISOString() }]); };
  const alive = useRef(true);

  const refresh = useCallback(async (res) => {
    const c = clientRef.current; if (!c) return;
    const list = res?.conversations || [];
    const t = {}; const l = {}; const p = {};
    for (const conv of list) {
      t[conv.id] = await c.title(conv.id);
      // who is in it (for names in the list): the cached roster, fetched once per conversation the first time it is seen
      let roster = await c.store.get(`roster:${conv.id}`);
      if (!roster && conv.status === "active" && conv.inGroup) {
        try { const d = await c.api.conversationDetail({ conversationId: conv.id }); roster = d.roster; await c.store.set(`roster:${conv.id}`, roster); } catch { /* shown by email later */ }
      }
      p[conv.id] = (roster || []).filter((x) => x.status === "active" || x.status === "pending");
      const msgs = await c.messages(conv.id);
      const m = [...msgs].reverse().find((x) => !x.deleted);
      l[conv.id] = m ? { text: m.text, at: m.at, from: m.from } : null;
    }
    if (!alive.current) return;
    setConversations(list); setTitles(t); setLast(l); setPeers(p); setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    alive.current = true;
    let stop = false;
    (async () => {
      if (!(await supported())) { setStatus("unsupported"); return; }
      try {
        const client = await startClient(orgId, email, onEvent);
        if (stop) return;
        clientRef.current = client;
        setStatus("ready");
        let backoff = 1000; let first = true;
        while (!stop) {
          if (document.hidden) { await new Promise((r) => setTimeout(r, 1500)); continue; }
          try {
            const res = await client.sync({ wait: first ? 0 : 15000 }); first = false;
            await refresh(res); backoff = 1000;
            if (res.fresh?.length) setTick((n) => n + 1);
          } catch (err) {
            if (err.code === "DEVICE_REVOKED") { setStatus("error"); setError("This browser was signed out of Secure Chat (device revoked)."); await client.wipeLocal(); return; }
            reportMetric(orgId, "chat.reconnect"); await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 30000);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (err) {
        if (err.status === 404) setStatus("off"); else { setStatus("error"); setError(err.message || "Could not start Secure Chat."); }
      }
    })();
    return () => { stop = true; alive.current = false; };
  }, [orgId, email, refresh]);

  const run = useCallback(async (fn) => {
    const c = clientRef.current; if (!c) throw new Error("Secure Chat is not ready yet.");
    const out = await fn(c);
    const res = await c.api.sync({ deviceId: c.device.deviceId, cursors: {}, since: null, wait: 0 }).catch(() => null);
    if (res) await refresh(res);
    return out;
  }, [refresh]);

  return { status, error, conversations, titles, last, peers, tick, securityEvents, client: () => clientRef.current, run, refresh };
}
