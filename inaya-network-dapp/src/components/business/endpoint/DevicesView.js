"use client";

// src/components/business/endpoint/DevicesView.js
//
// Device inventory and control (Competitive Expansion SOW G2/G3). People see and can remove their own devices; owners and admins see every
// device, can trust, block, remove, sign out, require sign-in again, and ask the app to wipe its OFFLINE DATA on that device. "Wipe" is an
// application-data wipe only: Inaya cannot erase an operating system or other apps, and it takes effect when the device next checks in.
// Also exports DeviceCheckIn, the invisible component that makes THIS browser a device and obeys commands sent to it.

import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";
import { useOrgFeatureFlags } from "../BetaFeaturesPanel";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return "-"; } };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); let d = {}; try { d = await r.json(); } catch { /* empty */ } if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status, data: d }); return d; };

const KEY = "inaya-device-id";
export function localDeviceId() {
  try { let id = localStorage.getItem(KEY); if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem(KEY, id); } return id; } catch { return null; }
}
function describeBrowser() {
  const ua = navigator.userAgent; const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser"; return { name: `${br} on ${os}`, osVersion: os };
}
/** Application-data wipe for the web app: this site's local storage (except the device id), session storage, IndexedDB databases and caches. */
export async function wipeLocalAppData() {
  try { const keep = localStorage.getItem(KEY); localStorage.clear(); if (keep) localStorage.setItem(KEY, keep); sessionStorage.clear(); } catch { /* ignore */ }
  try { const dbs = (await indexedDB.databases?.()) || []; await Promise.all(dbs.map((d) => new Promise((res) => { const r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => res(); }))); } catch { /* ignore */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
}

export function DeviceCheckIn({ orgId }) {
  const flags = useOrgFeatureFlags(orgId); const [blocked, setBlocked] = useState("");
  useEffect(() => {
    if (!flags.FEATURE_DEVICE_CONTROL) return; let stop = false; const deviceId = localDeviceId(); if (!deviceId) return;
    const signOut = async () => { try { await fetch("/api/orgs/logout", { method: "POST", credentials: "include" }); } catch { /* ignore */ } window.location.href = "/business"; };
    const beat = async (acks = []) => {
      try {
        let usage = 0; try { usage = (await navigator.storage?.estimate?.())?.usage || 0; } catch { /* ignore */ }
        const b = describeBrowser();
        const r = await j("/api/orgs/devices/heartbeat", { method: "POST", body: JSON.stringify({ orgId, deviceId, platform: "web", name: b.name, osVersion: b.osVersion, appVersion: "web", encryption: { webcrypto: !!globalThis.crypto?.subtle, secureStorage: false }, cache: { items: 0, bytes: usage }, acks }) });
        const done = [];
        for (const c of r.commands || []) { if (c.type === "wipe_cache") { await wipeLocalAppData(); done.push(c.id); } else if (c.type === "sign_out" || c.type === "reauth") { await j("/api/orgs/devices/heartbeat", { method: "POST", body: JSON.stringify({ orgId, deviceId, platform: "web", acks: [c.id] }) }).catch(() => {}); await signOut(); return; } else done.push(c.id); }
        if (done.length && !stop) await beat(done);
      } catch (e) { if (e.data?.code === "DEVICE_BLOCKED") { setBlocked(e.message); await wipeLocalAppData(); setTimeout(signOut, 2500); } }
    };
    beat(); const t = setInterval(() => beat(), 5 * 60_000); return () => { stop = true; clearInterval(t); };
  }, [orgId, flags.FEATURE_DEVICE_CONTROL]);
  return blocked ? <div role="alert" className="fixed top-0 inset-x-0 z-[2000] bg-red-500 text-white text-center text-sm py-2">{blocked} Signing you out…</div> : null;
}

export default function DevicesView({ orgId, canManage }) {
  const [scope, setScope] = useState("mine"); const [rows, setRows] = useState(null); const [sum, setSum] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [off, setOff] = useState(false); const here = typeof window !== "undefined" ? localDeviceId() : null;
  const load = useCallback(async () => {
    try { const d = await j(`/api/orgs/devices?orgId=${orgId}&scope=${scope}`); setRows(d.devices); setErr(""); if (canManage) setSum(await j(`/api/orgs/devices?orgId=${orgId}&scope=summary`)); }
    catch (e) { if (e.status === 404) setOff(true); else setErr(e.message); }
  }, [orgId, scope, canManage]);
  useEffect(() => { load(); }, [load]);
  const act = async (d, action, confirmText) => { if (confirmText && !window.confirm(confirmText)) return; setErr(""); setMsg(""); try { const r = await j(`/api/orgs/devices/${d.deviceId}`, { method: "POST", body: JSON.stringify({ orgId, action }) }); setMsg(r.note || (r.sessionsEnded != null ? `Done. ${r.sessionsEnded} sign-in${r.sessionsEnded === 1 ? "" : "s"} ended.` : "Done.")); load(); } catch (e) { setErr(e.message); } };
  if (off) return <EmptyState title="Device control is not enabled" description={canManage ? "Turn on “Device inventory and control” under Settings, Beta features." : "Your organization has not turned on device control yet."} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <button className={`${btn} ${scope === "mine" ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setScope("mine")}>My devices</button>
        {canManage && <button className={`${btn} ${scope === "org" ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setScope("org")}>Every device</button>}
      </div>
      {sum && scope === "org" && <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[12px]">{[["Devices", sum.total], ["Trusted", sum.trusted], ["Blocked", sum.blocked], ["Not seen in 30 days", sum.notSeen30Days], ["No secure storage", sum.withoutSecureStorage]].map(([l, v]) => <div key={l} className={`${card} p-2`}><p className={`text-[10px] uppercase font-bold ${muted}`}>{l}</p><p className="text-lg font-bold">{v}</p></div>)}</div>}
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}{msg && <p className="text-emerald-400 text-[12px]" role="status">{msg}</p>}
      {rows === null ? <p className={`text-[12px] ${muted}`}>Loading…</p> : rows.length === 0 ? <EmptyState compact icon="💻" description="No devices have checked in yet. This browser checks in automatically while device control is on." /> : rows.map((d) => (
        <div key={d.deviceId} className={`${card} p-3`}>
          <div className="flex flex-wrap items-center gap-2"><b className="text-[13px]">{d.name}</b>{d.deviceId === here && <span className="text-[10px] font-bold uppercase text-[#00f2fe]">this device</span>}
            <span className={`text-[10px] font-bold uppercase border rounded-full px-2 py-0.5 ${d.revokedAt ? "text-slate-400 border-slate-500/30" : d.blockedAt ? "text-red-400 border-red-400/30" : d.trust === "trusted" ? "text-emerald-400 border-emerald-400/30" : "text-amber-300 border-amber-400/30"}`}>{d.revokedAt ? "removed" : d.blockedAt ? "blocked" : d.trust}</span></div>
          <p className={`text-[11px] ${muted} mt-1`}>{scope === "org" ? `${d.email} · ` : ""}{d.platform}{d.osVersion ? ` · ${d.osVersion}` : ""}{d.appVersion ? ` · ${d.appVersion}` : ""} · first seen {when(d.firstSeenAt)} · last seen {when(d.lastSeenAt)}{d.lastIp ? ` · network ${d.lastIp}` : ""} · {d.encryption?.secureStorage ? "secure storage" : "no secure storage reported"}{d.cache?.bytes ? ` · local data ${(d.cache.bytes / 1048576).toFixed(1)} MB` : ""}{d.syncDisabled ? " · sync disabled" : ""}</p>
          {d.pendingCommands.length > 0 && <p className="text-[11px] text-amber-300 mt-1">Waiting for the device to check in: {d.pendingCommands.map((c) => c.type.replace("_", " ")).join(", ")}</p>}
          {!d.revokedAt && <div className="flex flex-wrap gap-1 mt-2">
            {canManage && (d.trust === "trusted" ? <button className={btn} onClick={() => act(d, "untrust")}>Stop trusting</button> : !d.blockedAt && <button className={btn} onClick={() => act(d, "trust")}>Trust</button>)}
            {canManage && (d.blockedAt ? <button className={btn} onClick={() => act(d, "unblock")}>Unblock</button> : <button className={`${btn} !text-red-400`} onClick={() => act(d, "block", `Block ${d.name}? Everyone signed in on it is signed out now.`)}>Block</button>)}
            <button className={btn} onClick={() => act(d, "signout", "Sign this device out everywhere?")}>Sign out</button><button className={btn} onClick={() => act(d, "reauth")}>Require sign-in again</button>
            <button className={btn} onClick={() => act(d, "wipe_cache", "Ask the app to delete its offline data on this device? This cannot be undone. It does not erase the device itself.")}>Wipe app data</button>
            {canManage && (d.syncDisabled ? <button className={btn} onClick={() => act(d, "enable_sync")}>Enable sync</button> : <button className={btn} onClick={() => act(d, "disable_sync")}>Disable sync</button>)}
            <button className={`${btn} !text-red-400`} onClick={() => act(d, "revoke", `Remove ${d.name} from the account? It can never check in again.`)}>Remove</button></div>}
        </div>))}
      <p className={`text-[11px] ${muted}`}>“Wipe app data” asks the Inaya app to delete its own offline data (chat and notes caches, offline files, tokens) on that device. It cannot erase the operating system or other apps, and it takes effect the next time the device checks in. A device that has not checked in yet is not restricted until it does.</p>
    </div>
  );
}
