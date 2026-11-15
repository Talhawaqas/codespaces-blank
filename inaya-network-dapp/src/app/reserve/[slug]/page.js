"use client";

// /reserve/{slug} -- a restaurant location's public reservation page (Hospitality SOW 8.8).
// Party size -> date -> a free time (in the restaurant's own time zone) -> details -> booked. No sign-in. The API is
// rate limited, returns only what a guest needs, and treats a repeated submit as the same booking.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { data });
  return data;
}
const box = "w-full border border-slate-300 rounded-lg px-3 py-2 text-base text-slate-900 bg-white";
const btn = "bg-teal-700 text-white font-semibold rounded-lg px-4 py-2.5 disabled:opacity-50";
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export default function ReservePage() {
  const { slug } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [party, setParty] = useState(2);
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState(null);
  const [time, setTime] = useState("");
  const [f, setF] = useState({ name: "", email: "", phone: "", occasion: "", note: "", marketingConsent: false, website: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [formError, setFormError] = useState("");
  // One id per page load: pressing Book twice, or a retry after a dropped connection, can't create two bookings.
  const key = useMemo(() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`), []);

  useEffect(() => { api(`/api/reserve/${slug}`).then(setInfo).catch((e) => setError(e.message)); }, [slug]);
  const todayKey = useMemo(() => { if (!info) return ""; try { return new Intl.DateTimeFormat("en-CA", { timeZone: info.location.timeZone }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } }, [info]);
  useEffect(() => { if (todayKey && !date) setDate(todayKey); }, [todayKey, date]);
  useEffect(() => {
    if (!info || !date) return;
    let live = true; setSlots(null); setTime("");
    api(`/api/reserve/${slug}?date=${date}&partySize=${party}`).then((r) => live && setSlots(r.slots)).catch((e) => live && (setSlots([]), setFormError(e.message)));
    return () => { live = false; };
  }, [info, slug, date, party]);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setFormError("");
    try { setDone(await api(`/api/reserve/${slug}`, { method: "POST", body: JSON.stringify({ ...f, partySize: party, date, time, idempotencyKey: key }) })); }
    catch (err) { setFormError(err.message + (err.data?.alternatives?.length ? ` Other times that day: ${err.data.alternatives.join(", ")}.` : "")); if (err.data?.alternatives) { setTime(""); } }
    finally { setBusy(false); }
  };

  if (error) return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6"><p className="text-slate-700">{error}</p></main>;
  if (!info) return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6"><p className="text-slate-500">Loading…</p></main>;
  const loc = info.location, maxDate = (() => { const t = new Date(`${todayKey || "2026-01-01"}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + (info.policy.horizonDays || 60)); return t.toISOString().slice(0, 10); })();
  const dayHours = date ? loc.hours?.[DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]] || [] : [];

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 p-4 sm:p-8">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-200 p-5 sm:p-8 space-y-5">
        <header>
          <h1 className="text-2xl font-bold">{info.business}</h1>
          <p className="text-slate-600">{loc.name}{loc.address ? ` · ${loc.address}` : ""}{loc.phone ? ` · ${loc.phone}` : ""}</p>
        </header>
        {done ? (
          <section aria-live="polite" className="space-y-3">
            <h2 className="text-xl font-semibold">{done.status === "CONFIRMED" ? "Your table is booked" : done.ref ? "Request received" : "Thank you"}</h2>
            {done.ref && <p>{done.partySize} {done.partySize === 1 ? "guest" : "guests"} on {new Date(`${done.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} at {done.time}. Reference <strong>{done.ref}</strong>.</p>}
            <p className="text-slate-600">{done.status === "CONFIRMED" ? (done.emailSent ? "We've emailed you a confirmation with a link to view or cancel your reservation." : "Please keep this reference. We couldn't confirm that the confirmation email was sent, so use the link below to view or cancel your reservation.") : done.ref ? "This isn't confirmed yet. We'll email you once the restaurant has confirmed it." : ""}</p>
            {done.manageToken && <a className="underline text-teal-700" href={`/reserve/manage/${done.manageToken}`}>View or cancel this reservation</a>}
          </section>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-sm font-medium">Guests
                <select className={box} value={party} onChange={(e) => setParty(Number(e.target.value))}>{Array.from({ length: info.policy.maxPartyOnline }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select>
              </label>
              <label className="space-y-1 text-sm font-medium">Date
                <input type="date" className={box} required min={todayKey} max={maxDate} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
              </label>
            </div>
            <p className="text-sm text-slate-500">For parties larger than {info.policy.maxPartyOnline}, please call us. Times are shown in the restaurant&apos;s time zone ({loc.timeZone}).</p>
            <fieldset>
              <legend className="text-sm font-medium mb-2">Time</legend>
              {slots === null ? <p className="text-slate-500">Checking availability…</p> : !slots.length ? <p className="text-slate-600">{dayHours.length ? "No tables are free that day for this party size. Try another date." : "We're closed that day. Try another date."}</p> : (
                <div className="flex flex-wrap gap-2">{slots.map((s) => <button type="button" key={s.time} aria-pressed={time === s.time} onClick={() => setTime(s.time)} className={`px-3 py-2 rounded-lg border text-sm ${time === s.time ? "bg-teal-700 text-white border-teal-700" : "border-slate-300 text-slate-800"}`}>{s.time}</button>)}</div>
              )}
            </fieldset>
            {time && (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="space-y-1 text-sm font-medium">Your name<input className={box} required autoComplete="name" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
                  <label className="space-y-1 text-sm font-medium">Email<input className={box} type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
                  <label className="space-y-1 text-sm font-medium">Phone (optional)<input className={box} type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
                  <label className="space-y-1 text-sm font-medium">Occasion (optional)<input className={box} maxLength={80} value={f.occasion} onChange={(e) => setF({ ...f, occasion: e.target.value })} /></label>
                </div>
                <label className="space-y-1 text-sm font-medium block">Anything we should know? (optional)<textarea className={`${box} h-20`} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
                {/* Honeypot: hidden from people, filled by bots. */}
                <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label></div>
                <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" className="mt-1" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} /><span>Email me news and offers from {info.business}. Optional, and separate from this booking: you can unsubscribe at any time.</span></label>
                <p className="text-sm text-slate-500">We use your details to manage this reservation and to send your confirmation and reminder.{info.policy.needsConfirmation ? " The restaurant confirms each booking by email." : ""}{info.policy.cancelNoticeHours ? ` You can cancel online up to ${info.policy.cancelNoticeHours} hours before.` : ""}</p>
                {info.policy.policyText && <p className="text-sm text-slate-600 border-l-2 border-slate-300 pl-3">{info.policy.policyText}</p>}
              </>
            )}
            {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
            <button className={btn} disabled={busy || !time}>{busy ? "Booking…" : time ? `Book for ${party} at ${time}` : "Choose a time"}</button>
          </form>
        )}
      </div>
      <p className="text-center text-xs text-slate-400 mt-4">Reservations by Inaya Business Workspace</p>
    </main>
  );
}
