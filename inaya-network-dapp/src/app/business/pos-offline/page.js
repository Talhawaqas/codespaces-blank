"use client";

// app/business/pos-offline/page.js -- Inaya Commerce, offline selling: the offline till.
// Opens with NO internet (kept on the till by /pos-offline-sw.js), so a shop can keep selling after the computer or the
// Inaya app restarts during an outage. It needs nothing from the server to sell: it uses this till's encrypted offline
// pack and queue (offlineStore.js) -- the same ones the Point of Sale screen uses -- and sends the queue as soon as the
// connection is back. Cash only, shelf prices, guest sales; everything is checked again by the server on sync.
import { useEffect, useState } from "react";
import { lastTill } from "../../../lib/commerce/offlineStore";
import { useOfflineTill, OfflineRegister } from "../../../components/business/commerce/OfflinePos";

const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "inline-flex items-center min-h-[40px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] hover:border-[var(--inaya-accent)]";

export default function PosOfflinePage() {
  const [till, setTill] = useState(undefined);
  useEffect(() => { setTill(lastTill()); }, []);
  return <main className="bw min-h-screen bg-[var(--inaya-bg,#0f1114)] text-[var(--inaya-text-primary)] p-3 md:p-5 space-y-3">
    <header className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-bold">Offline till</h1><span className={`text-sm ${muted}`}>Inaya Business OS</span></header>
    {till === undefined ? <p className={muted}>Loading…</p> : !till ? <div className={`${card} p-4 max-w-xl`}>
      <p className="font-semibold">This computer has no offline till yet.</p>
      <p className={`text-sm ${muted} mt-1`}>Open Point of Sale once while online, with a register chosen, a shift open and offline selling switched on (Point of Sale &gt; Setup). The till then keeps itself ready.</p>
      <a className={`${btn} mt-3`} href="/business?view=pos">Open Point of Sale</a>
    </div> : <OfflineTill orgId={till.orgId} registerId={till.registerId} />}
  </main>;
}

function OfflineTill({ orgId, registerId }) {
  const t = useOfflineTill({ orgId, registerId, shiftId: null, enabled: false });
  const status = t.online
    ? (t.queued ? `Online again: sending ${t.queued} offline sale${t.queued === 1 ? "" : "s"}…` : "Online again: every offline sale has been sent.")
    : `Offline: cash sales at shelf prices are saved encrypted on this till${t.queued ? ` (${t.queued} waiting to sync)` : ""}.`;
  return <div className="space-y-3">
    <div role="status" className={`p-2 rounded-xl border text-sm flex flex-wrap items-center gap-2 ${t.online ? "border-emerald-500" : "border-amber-500 bg-amber-500/10"}`}>
      <span>{status}</span>
      {t.online && t.sync?.error ? <span className="text-red-500">{/sign|session|401|log/i.test(t.sync.error) ? "Sign in again to send the offline sales." : `Offline sales could not be sent yet: ${t.sync.error}`} {/sign|session|401|log/i.test(t.sync.error) && <a className="underline" href="/business">Sign in</a>}</span> : null}
      {t.sync?.rejected ? <span className="text-red-500">{t.sync.rejected} not recorded: sent to the manager (Offline review).</span> : null}
      {t.online && <a className={`${btn} ml-auto`} href="/business?view=pos">Back to the full workspace</a>}
    </div>
    {t.problem ? <div className={`${card} p-4 max-w-xl`}><p>{t.problem}</p></div>
      : t.pack ? <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]"><OfflineRegister key={t.pack.packId} orgId={orgId} registerId={registerId} pack={t.pack} onQueued={t.reloadLocal} /></div>
      : <p className={muted}>Loading the till…</p>}
    {t.pack && <p className={`text-xs ${muted}`}>Till {t.pack.registerCode} · {t.pack.location} · cashier {t.pack.cashierEmail} · offline until {new Date(t.pack.expiresAt).toLocaleString()} · {Math.max(0, t.pack.maxSales - (t.pack.nextSeq || 1) + 1)} offline sales left</p>}
  </div>;
}
