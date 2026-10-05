"use client";

// src/components/business/shares/LockControl.js
//
// Lock a document while you edit it (Sharing 2.0 B4). Shows who holds the lock and until when; the holder can renew or release; someone with
// Manage access or an organization admin can break it. Enforcement happens on the server (storage API, DirectSync, new versions), not here.

import { useCallback, useEffect, useState } from "react";
import { sharesApi } from "./AdvancedShareForm";

const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; } };

export default function LockControl({ orgId, documentId }) {
  const [lock, setLock] = useState(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setLock(await sharesApi(`/api/orgs/file-locks?orgId=${orgId}&documentId=${documentId}`)); setErr(""); } catch (e) { setErr(e.message); } }, [orgId, documentId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { setBusy(true); setErr(""); try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const mine = !!lock?.mine;
  return (
    <div className="mt-2 text-[12px]" aria-live="polite">
      <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1">Edit lock</p>
      {!lock ? <p className="text-[var(--inaya-text-muted)]">{err || "Loading…"}</p> : !lock.locked ? (
        <div className="flex items-center gap-2"><span className="text-[var(--inaya-text-muted)]">Not locked.</span><button className={btn} disabled={busy} onClick={() => run(() => sharesApi("/api/orgs/file-locks", { method: "POST", body: JSON.stringify({ orgId, documentId, leaseMinutes: 30 }) }))}>Lock for 30 minutes</button></div>
      ) : (
        <div className="flex flex-wrap items-center gap-2"><span>{mine ? "You are editing this." : <>Locked by <b>{lock.byEmail}</b>.</>} Until {when(lock.expiresAt)}.</span>
          {mine && <button className={btn} disabled={busy} onClick={() => run(() => sharesApi("/api/orgs/file-locks", { method: "POST", body: JSON.stringify({ orgId, documentId, leaseMinutes: 30 }) }))}>Renew</button>}
          <button className={btn} disabled={busy} onClick={() => { if (mine || window.confirm(`Break ${lock.byEmail}'s lock? They may lose unsaved work.`)) run(() => sharesApi(`/api/orgs/file-locks?orgId=${orgId}&documentId=${documentId}${mine ? "" : "&force=1"}`, { method: "DELETE" })); }}>{mine ? "Unlock" : "Break lock"}</button></div>)}
      {err && lock && <p className="text-red-400 mt-1" role="alert">{err}</p>}
    </div>
  );
}
