"use client";

// /book/manage/{token} -- the customer's own appointment (link in their confirmation and reminder emails):
// see it, reschedule to another free time, or cancel. No sign-in; the token is the key and rotates on every move.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtLong = (d) => new Date(d).toLocaleString([], { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const btn = "px-4 py-2 rounded-lg font-medium disabled:opacity-40";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

export default function ManageAppointment() {
  const { token: initial } = useParams();
  const [token, setToken] = useState(initial);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("view");
  const [slots, setSlots] = useState(null);
  const [day, setDay] = useState("");
  const [pick, setPick] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = () => api(`/api/book/manage/${token}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const openReschedule = async () => {
    setMode("reschedule"); setSlots(null);
    try { const d = await api(`/api/book/manage/${token}?slots=1&from=${new Date().toISOString()}&to=${new Date(Date.now() + 21 * 86400000).toISOString()}`); setSlots(d.slots); setDay(d.slots[0] ? dayKey(d.slots[0]) : ""); } catch (e) { setError(e.message); }
  };
  const byDay = useMemo(() => { const m = new Map(); for (const s of slots || []) { const k = dayKey(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return m; }, [slots]);
  const act = async (body, ok) => {
    setBusy(true); setError("");
    try {
      const r = await api(`/api/book/manage/${token}`, { method: "POST", body: JSON.stringify(body) });
      setNote(ok); setMode("view");
      if (r.newToken) { window.history.replaceState(null, "", `/book/manage/${r.newToken}`); setToken(r.newToken); } else load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const a = data?.appointment;
  return (
    <main className="min-h-screen bg-[#f5f6f8] text-[#1d2433] px-4 py-8" style={{ colorScheme: "light" }}>
      <div className="max-w-xl mx-auto bg-white border border-[#e3e6eb] rounded-xl p-6 shadow-sm space-y-4">
        {error && <p className="text-[#b42318]" role="alert">{error}</p>}
        {!data && !error && <p className="text-[#6b7280]">Loading…</p>}
        {a && <>
          <p className="text-sm text-[#6b7280]">{data.businessName}</p>
          <h1 className="text-2xl font-semibold">{a.typeName}</h1>
          <p className="text-lg">{fmtLong(a.start)} – {fmtTime(a.end)}</p>
          <p className="text-sm text-[#475467]">Status: {a.status === "CONFIRMED" ? "confirmed" : a.status === "PENDING" ? "waiting for confirmation" : a.status.toLowerCase().replace("_", "-")}</p>
          {a.location?.joinLink && a.status === "CONFIRMED" && <a href={a.location.joinLink} className={`${btn} inline-block bg-[#0b6e75] text-white`}>Join the meeting</a>}
          {a.location && !a.location.joinLink && a.location.detail && <p className="text-[#475467]">{a.location.detail}</p>}
          {note && <p className="text-[#067647]">{note}</p>}
          {data.canChange && mode === "view" && (
            <div className="flex flex-wrap gap-2 pt-2">
              <button className={`${btn} border border-[#d0d5dd]`} onClick={openReschedule}>Reschedule</button>
              <button className={`${btn} border border-[#fda29b] text-[#b42318]`} onClick={() => setMode("cancel")}>Cancel</button>
            </div>
          )}
          {mode === "reschedule" && (
            <div className="space-y-3 border-t border-[#e3e6eb] pt-4">
              <h2 className="font-semibold">Choose a new time</h2>
              {!slots ? <p className="text-[#6b7280]">Finding free times…</p> : slots.length === 0 ? <p className="text-[#6b7280]">No other free times in the next three weeks. Reply to your confirmation email and we&apos;ll help.</p> : <>
                <div className="flex gap-2 overflow-x-auto pb-1">{[...byDay.keys()].map((k) => <button key={k} onClick={() => setDay(k)} className={`shrink-0 px-3 py-2 rounded-lg border text-sm ${day === k ? "bg-[#0b6e75] text-white border-[#0b6e75]" : "border-[#e3e6eb]"}`}>{new Date(byDay.get(k)[0]).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</button>)}</div>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">{(byDay.get(day) || []).map((s) => <button key={s} onClick={() => setPick(s)} className={`py-2 rounded-lg border text-sm ${pick === s ? "bg-[#0b6e75] text-white border-[#0b6e75]" : "border-[#d0d5dd]"}`}>{fmtTime(s)}</button>)}</div>
              </>}
              <div className="flex gap-2"><button disabled={!pick || busy} className={`${btn} bg-[#0b6e75] text-white`} onClick={() => act({ action: "reschedule", start: pick }, "Moved. We've emailed you the new time and an updated invite.")}>{pick ? `Move to ${fmtLong(pick)}` : "Choose a time"}</button><button className={`${btn} border border-[#d0d5dd]`} onClick={() => setMode("view")}>Back</button></div>
            </div>
          )}
          {mode === "cancel" && (
            <div className="space-y-3 border-t border-[#e3e6eb] pt-4">
              <h2 className="font-semibold">Cancel this appointment?</h2>
              <textarea rows={3} className="w-full border border-[#d0d5dd] rounded-lg px-3 py-2" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2"><button disabled={busy} className={`${btn} bg-[#b42318] text-white`} onClick={() => act({ action: "cancel", reason }, "Cancelled. We've emailed you a confirmation.")}>Yes, cancel</button><button className={`${btn} border border-[#d0d5dd]`} onClick={() => setMode("view")}>Keep it</button></div>
            </div>
          )}
        </>}
        <p className="text-xs text-[#6b7280] pt-2">Times shown in your time zone ({tz()}).</p>
      </div>
    </main>
  );
}
