"use client";

// src/components/business/chat/useChat.js
//
// Browser state for Secure Chat: starts this device's ChatClient (keys and decrypted cache live only in this browser, sealed in
// IndexedDB), runs the sync loop (long poll with backoff, paused while the tab is hidden), and exposes plain data to the view.
// The server only ever sees ciphertext and metadata. See docs/architecture/e2ee-chat-key-management.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { reportMetric } from "./reportMetric.js";
import { isDesktopApp, devicePlatform, deviceLabel, native } from "./desktop.js";
import { registerLiveChat } from "./signOut.js";

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
      const client = new ChatClient({ api: new HttpChatApi({ orgId }), store, orgId, email, label: deviceLabel(), platform: devicePlatform(), jitterMs: 250, onSecurityEvent: (e) => onSecurityEvent.current?.(e) });
      await client.init();
      return client;
    })().catch((err) => { starting.delete(key); throw err; }));
  }
  return starting.get(key);
}

// Only one window of this browser profile (or desktop app) may run Secure Chat at a time: two would each hold their own copy of the same
// encrypted conversation state and the same device. A Web Lock names the owner; another window asks the owner to hand over (BroadcastChannel) and
// waits for the lock, so the owner always finishes its current sync before the new one starts.
const lockName = (orgId, email) => `inaya-chat:${orgId}:${email}`;
const heldHere = new Set(); // lock names this window currently holds
const hasLocks = () => typeof navigator !== "undefined" && !!navigator.locks && typeof BroadcastChannel !== "undefined";

export function useChat({ orgId, email }) {
  const [status, setStatus] = useState("starting"); // starting | ready | unsupported | off | error | elsewhere
  const [attempt, setAttempt] = useState(0);
  const takeOverRef = useRef(false);
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
    let stop = false; let release = null; let chan = null;
    const claim = (wait, signal) => new Promise((resolve, reject) => {
      navigator.locks.request(lockName(orgId, email), wait ? { signal } : { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true); return new Promise((r) => { release = r; });
      }).catch((e) => { if (e?.name === "AbortError") resolve(false); else reject(e); });
    });
    (async () => {
      if (!(await supported())) { setStatus("unsupported"); return; }
      if (hasLocks()) {
        chan = new BroadcastChannel(`inaya-chat-handoff:${lockName(orgId, email)}`);
        let got = false;
        if (takeOverRef.current) {
          takeOverRef.current = false; setStatus("switching"); chan.postMessage({ type: "handoff" });
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000); got = await claim(true, ctl.signal); clearTimeout(t);
        } else if (heldHere.has(lockName(orgId, email))) {
          // This same window is still winding down a previous mount (a view switch or a dev re-mount): wait for it instead of treating it as another window.
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000); got = await claim(true, ctl.signal); clearTimeout(t);
        } else got = await claim(false);
        if (stop) { release?.(); return; }
        if (!got) { setStatus("elsewhere"); return; }
        heldHere.add(lockName(orgId, email));
        chan.onmessage = (ev) => { if (ev.data?.type === "handoff") stop = true; };
      }
      try {
        const client = await startClient(orgId, email, onEvent);
        if (stop) return;
        clientRef.current = client; registerLiveChat(client);
        setStatus("ready");
        let backoff = 1000; let first = true; let lastUnread = 0;
        while (!stop) {
          // A hidden browser tab pauses; the desktop app keeps syncing while it sits in the tray, so a message can still raise a native notification.
          if (document.hidden && !isDesktopApp()) { await new Promise((r) => setTimeout(r, 1500)); continue; }
          try {
            const res = await client.sync({ wait: first ? 0 : 15000 }); first = false;
            if (stop) break;
            await refresh(res); backoff = 1000;
            if (res.fresh?.length) setTick((n) => n + 1);
            if (isDesktopApp()) {
              // Native alerts carry a count only, never a name or text. Raised when the unread total grows while the window is hidden or not focused.
              const unread = (res.conversations || []).reduce((n, c) => n + (c.unread || 0), 0);
              if (unread > lastUnread && (document.hidden || !document.hasFocus())) native("notify_chat_message", { count: unread });
              if (unread !== lastUnread) native("set_chat_unread", { count: unread });
              lastUnread = unread;
            }
          } catch (err) {
            if (err.code === "DEVICE_REVOKED") { setStatus("error"); setError("This device was signed out of Secure Chat (device revoked)."); await client.wipeLocal(); return; }
            reportMetric(orgId, "chat.reconnect"); await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 30000);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        if (clientRef.current === client) { clientRef.current = null; registerLiveChat(null); starting.delete(orgId + ":" + email); if (alive.current) setStatus("elsewhere"); }
      } catch (err) {
        if (err.status === 404) setStatus("off"); else { setStatus("error"); setError(err.message || "Could not start Secure Chat."); }
      } finally { heldHere.delete(lockName(orgId, email)); release?.(); chan?.close(); }
    })();
    return () => { stop = true; alive.current = false; };
  }, [orgId, email, refresh, attempt]);

  const takeOver = useCallback(() => { takeOverRef.current = true; alive.current = true; setStatus("starting"); setAttempt((n) => n + 1); }, []);

  const run = useCallback(async (fn) => {
    const c = clientRef.current; if (!c) throw new Error("Secure Chat is not ready yet.");
    const out = await fn(c);
    const res = await c.api.sync({ deviceId: c.device.deviceId, cursors: {}, since: null, wait: 0 }).catch(() => null);
    if (res) await refresh(res);
    return out;
  }, [refresh]);

  return { status, error, takeOver, conversations, titles, last, peers, tick, securityEvents, client: () => clientRef.current, run, refresh };
}
