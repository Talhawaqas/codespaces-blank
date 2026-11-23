"use client";

// app/business/pos-scan/page.js -- Inaya Commerce: the phone as a wireless barcode scanner for a computer till.
// Opened by scanning the QR code the till shows (Point of Sale > Phone). The pairing key is in the URL's #fragment, so it
// never reaches server logs or other sites. No sign-in on the phone: the key can only add barcode text to that one till.
import { useCallback, useEffect, useState } from "react";
import { CameraScanner } from "../../../components/business/commerce/CameraScanner";

const btn = "min-h-[48px] px-4 rounded-lg text-base font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)]";
const primary = "min-h-[56px] px-4 rounded-xl text-lg font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] w-full";
const muted = "text-[var(--inaya-text-muted)]";

async function send(body) {
  const r = await fetch("/api/pos-scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch { /* empty */ } if (!r.ok) throw Object.assign(new Error(d.error || "Could not send."), { code: d.code }); return d;
}

export default function PosScanPage() {
  const [token, setToken] = useState(null); const [state, setState] = useState("checking"); const [scanning, setScanning] = useState(false); const [sent, setSent] = useState([]); const [err, setErr] = useState(""); const [manual, setManual] = useState("");
  useEffect(() => { const t = new URLSearchParams(window.location.hash.slice(1)).get("t"); setToken(t || ""); }, []);
  useEffect(() => { if (token === null) return; if (!token) { setState("invalid"); return; } send({ token, check: true }).then(() => setState("ready")).catch((e) => setState(e.code === "PAIR_ENDED" ? "ended" : "invalid")); }, [token]);
  const push = useCallback(async (code) => {
    setErr(""); const item = { code, at: new Date(), ok: null }; setSent((s) => [item, ...s].slice(0, 30));
    try { await send({ token, code }); item.ok = true; } catch (e) { item.ok = false; setErr(e.message); if (e.code === "PAIR_ENDED") { setScanning(false); setState("ended"); } }
    setSent((s) => [...s]);
  }, [token]);
  return <main className="bw min-h-screen p-4 space-y-3 text-[var(--inaya-text-primary)] max-w-md mx-auto">
    <h1 className="text-xl font-bold">Phone scanner</h1>
    {state === "checking" && <p className={muted}>Connecting to the till…</p>}
    {state === "invalid" && <p>This link isn't valid. On the till, open Point of Sale and choose <b>Phone</b> to show a new QR code.</p>}
    {state === "ended" && <p>This phone is no longer connected to the till (the pairing was ended or is over 12 hours old). Scan the QR code on the till again.</p>}
    {state === "ready" && <>
      <p className={`text-sm ${muted}`}>Connected. Every barcode you scan appears on the till, like a USB scanner.</p>
      <button className={primary} onClick={() => setScanning(true)}>Start scanning</button>
      <div className="flex gap-2"><input aria-label="Type a code" className="flex-1 min-h-[48px] rounded-lg border border-[var(--inaya-border)] bg-[var(--inaya-surface)] px-3" placeholder="Or type a code" value={manual} onChange={(e) => setManual(e.target.value)} /><button className={btn} disabled={!manual.trim()} onClick={() => { push(manual.trim()); setManual(""); }}>Send</button></div>
      {err && <p className="text-red-500 text-sm" role="alert">{err}</p>}
      {sent.length > 0 && <ul className="text-sm divide-y divide-[var(--inaya-border)]">{sent.map((x, i) => <li key={i} className="py-1 flex justify-between"><span className="font-mono">{x.code}</span><span className={x.ok === false ? "text-red-500" : x.ok ? "text-emerald-600" : muted}>{x.ok === false ? "not sent" : x.ok ? "sent" : "sending…"}</span></li>)}</ul>}
    </>}
    {scanning && <CameraScanner onCode={push} onClose={() => setScanning(false)} />}
  </main>;
}
