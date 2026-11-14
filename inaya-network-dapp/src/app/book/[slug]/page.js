"use client";

// /book/{slug} -- the public customer self-service booking portal (Appointment Calendar SOW).
// Pick a service -> (optionally a person) -> a day and time in the visitor's own time zone -> details -> booked.
// Also hosts the enquiry form. No sign-in; the API is rate limited and never exposes staff email addresses.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtLong = (d) => new Date(d).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const WHERE = { inaya_meet: "Online video call", video_url: "Online video call", phone: "Phone call", in_person: "In person" };

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

export default function BookingPage() {
  const { slug } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("book");
  const [type, setType] = useState(null);
  const [staffKey, setStaffKey] = useState("");
  const [weekStart, setWeekStart] = useState(() => startOfDay(new Date()));
  const [slots, setSlots] = useState(null);
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", note: "", answers: {}, consent: false, website: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [enq, setEnq] = useState({ name: "", email: "", phone: "", company: "", message: "", consent: false, website: "" });
  const [enqDone, setEnqDone] = useState(false);

  useEffect(() => { api(`/api/book/${slug}`).then((d) => { setPage(d); if (d.types.length === 1) setType(d.types[0]); }).catch((e) => setError(e.message)); }, [slug]);
  useEffect(() => {
    if (!type) return; setSlots(null); setSlot("");
    const qs = new URLSearchParams({ typeId: type.id, from: weekStart.toISOString(), to: addDays(weekStart, 14).toISOString(), ...(staffKey ? { staffKey } : {}) });
    api(`/api/book/${slug}/slots?${qs}`).then((d) => { setSlots(d.slots); const first = d.slots[0]; setDay(first ? dayKey(first) : ""); }).catch((e) => setError(e.message));
  }, [slug, type, staffKey, weekStart]);

  const byDay = useMemo(() => { const m = new Map(); for (const s of slots || []) { const k = dayKey(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return m; }, [slots]);
  const color = page?.page?.brandColor || "#0b6e75";
  const btn = { background: color, color: "#fff" };

  const pickSlot = (s) => { setSlot(s); api(`/api/book/${slug}/start`, { method: "POST", body: "{}" }).catch(() => {}); };
  const book = async () => {
    setBusy(true); setError("");
    try {
      const r = await api(`/api/book/${slug}/book`, { method: "POST", body: JSON.stringify({ typeId: type.id, start: slot, staffKey: staffKey || undefined, name: form.name, email: form.email, phone: form.phone, note: form.note, answers: Object.entries(form.answers).map(([id, value]) => ({ id, value })), timeZone: tz(), consentMarketing: form.consent, website: form.website }) });
      setDone(r);
    } catch (e) { setError(e.message); if (/taken|available/.test(e.message)) { setSlot(""); setWeekStart((w) => new Date(w)); } } finally { setBusy(false); }
  };
  const sendEnquiry = async () => {
    setBusy(true); setError("");
    try { await api(`/api/book/${slug}/enquiry`, { method: "POST", body: JSON.stringify({ ...enq, consentMarketing: enq.consent }) }); setEnqDone(true); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const shell = (children) => (
    <main className="min-h-screen bg-[#f5f6f8] text-[#1d2433] px-4 py-8" style={{ colorScheme: "light" }}>
      <div className="max-w-3xl mx-auto">
        <div className="h-1.5 rounded-t-xl" style={{ background: color }} />
        <div className="bg-white border border-[#e3e6eb] rounded-b-xl p-5 sm:p-8 shadow-sm">{children}</div>
        <p className="text-center text-xs text-[#6b7280] mt-4">Times shown in your time zone ({tz()}). Booking by Inaya.</p>
      </div>
    </main>
  );

  if (error && !page) return shell(<p className="text-[#b42318]">{error}</p>);
  if (!page) return shell(<p className="text-[#6b7280]">Loading…</p>);
  const p = page.page;

  if (done) return shell(
    <div className="space-y-3 text-center py-6">
      <div className="mx-auto w-12 h-12 rounded-full flex items-center justify-center text-white text-2xl" style={{ background: color }}>✓</div>
      <h1 className="text-2xl font-semibold">{done.status === "PENDING" ? "Request received" : "You're booked"}</h1>
      <p className="text-lg">{done.typeName}</p>
      <p>{fmtLong(done.start)} – {fmtTime(done.end)}</p>
      {done.location?.detail && <p className="text-[#475467]">{done.location.detail}</p>}
      <p className="text-[#475467]">{done.status === "PENDING" ? `${p.businessName} will confirm shortly. ` : ""}{done.emailSent ? "We've emailed you the details and a calendar invite." : "We couldn't send the confirmation email, so please note these details."}</p>
      <a href={done.manageUrl} className="inline-block mt-2 underline text-[#475467]">Reschedule or cancel</a>
    </div>
  );

  return shell(
    <div className="space-y-6">
      <div>
        <p className="text-sm text-[#6b7280]">{p.businessName}</p>
        <h1 className="text-2xl font-semibold mt-1">{p.title}</h1>
        {p.intro && <p className="text-[#475467] mt-2 whitespace-pre-wrap">{p.intro}</p>}
      </div>
      {p.enquiryEnabled && (
        <div className="flex gap-2 border-b border-[#e3e6eb]">
          {[["book", "Book a time"], ["enquiry", "Send an enquiry"]].map(([k, t]) => <button key={k} onClick={() => setMode(k)} className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${mode === k ? "" : "border-transparent text-[#6b7280]"}`} style={mode === k ? { borderColor: color, color } : {}}>{t}</button>)}
        </div>
      )}
      {error && <p className="text-[#b42318] text-sm" role="alert">{error}</p>}

      {mode === "enquiry" ? (enqDone ? <p className="text-[#067647]">Thanks, {enq.name.split(" ")[0]}. We&apos;ve received your enquiry and emailed you a confirmation.</p> : (
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Your name" value={enq.name} onChange={(v) => setEnq({ ...enq, name: v })} />
            <Field label="Email" type="email" value={enq.email} onChange={(v) => setEnq({ ...enq, email: v })} />
            <Field label="Phone (optional)" value={enq.phone} onChange={(v) => setEnq({ ...enq, phone: v })} />
            <Field label="Company (optional)" value={enq.company} onChange={(v) => setEnq({ ...enq, company: v })} />
          </div>
          <label className="block"><span className="text-sm text-[#344054]">How can we help?</span><textarea rows={5} className="mt-1 w-full border border-[#d0d5dd] rounded-lg px-3 py-2" value={enq.message} onChange={(e) => setEnq({ ...enq, message: e.target.value })} /></label>
          <input tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" value={enq.website} onChange={(e) => setEnq({ ...enq, website: e.target.value })} />
          <label className="flex items-start gap-2 text-sm text-[#475467]"><input type="checkbox" checked={enq.consent} onChange={(e) => setEnq({ ...enq, consent: e.target.checked })} className="mt-1" /> Send me occasional news and offers from {p.businessName}. You can unsubscribe at any time.</label>
          {p.privacyNote && <p className="text-xs text-[#6b7280]">{p.privacyNote}</p>}
          <button disabled={busy || !enq.name || !enq.email || !enq.message} onClick={sendEnquiry} className="px-5 py-2.5 rounded-lg font-medium disabled:opacity-40" style={btn}>Send enquiry</button>
        </div>
      )) : (
        <div className="space-y-6">
          <section>
            <h2 className="font-semibold mb-2">1. Choose a service</h2>
            <div className="grid sm:grid-cols-2 gap-2">
              {page.types.map((t) => (
                <button key={t.id} onClick={() => { setType(t); setStaffKey(""); }} className={`text-left p-3 rounded-lg border ${type?.id === t.id ? "ring-2" : "border-[#e3e6eb]"}`} style={type?.id === t.id ? { borderColor: color, "--tw-ring-color": color } : {}}>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-sm text-[#6b7280]">{t.durationMinutes} min · {WHERE[t.location]}{t.location === "in_person" && t.locationDetail ? `, ${t.locationDetail}` : ""}</p>
                  {t.description && <p className="text-sm text-[#475467] mt-1">{t.description}</p>}
                </button>
              ))}
            </div>
            {page.types.length === 0 && <p className="text-[#6b7280]">No appointments are offered right now.</p>}
          </section>

          {type?.staff && type.staff.length > 1 && (
            <section>
              <h2 className="font-semibold mb-2">With</h2>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setStaffKey("")} className={`px-3 py-1.5 rounded-full border text-sm ${!staffKey ? "text-white" : "border-[#d0d5dd]"}`} style={!staffKey ? btn : {}}>Anyone available</button>
                {type.staff.map((s) => <button key={s.key} onClick={() => setStaffKey(s.key)} className={`px-3 py-1.5 rounded-full border text-sm ${staffKey === s.key ? "text-white" : "border-[#d0d5dd]"}`} style={staffKey === s.key ? btn : {}}>{s.name}</button>)}
              </div>
            </section>
          )}

          {type && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold">2. Choose a time</h2>
                <div className="flex gap-1">
                  <button disabled={weekStart <= startOfDay(new Date())} onClick={() => setWeekStart((w) => addDays(w, -14))} className="px-2 py-1 border border-[#d0d5dd] rounded disabled:opacity-30" aria-label="Earlier">‹</button>
                  <button onClick={() => setWeekStart((w) => addDays(w, 14))} className="px-2 py-1 border border-[#d0d5dd] rounded" aria-label="Later">›</button>
                </div>
              </div>
              {!slots ? <p className="text-[#6b7280]">Finding free times…</p> : slots.length === 0 ? <p className="text-[#6b7280]">No free times in these two weeks. Try later dates{p.enquiryEnabled ? " or send an enquiry" : ""}.</p> : (
                <>
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {Array.from({ length: 14 }, (_, i) => addDays(weekStart, i)).map((d) => {
                      const k = dayKey(d); const n = byDay.get(k)?.length || 0;
                      return <button key={k} disabled={!n} onClick={() => setDay(k)} className={`shrink-0 w-16 py-2 rounded-lg border text-center disabled:opacity-30 ${day === k ? "text-white" : "border-[#e3e6eb]"}`} style={day === k ? btn : {}}><span className="block text-xs">{d.toLocaleDateString([], { weekday: "short" })}</span><span className="block text-lg font-semibold">{d.getDate()}</span><span className="block text-[10px]">{d.toLocaleDateString([], { month: "short" })}</span></button>;
                    })}
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mt-2">
                    {(byDay.get(day) || []).map((s) => <button key={s} onClick={() => pickSlot(s)} className={`py-2 rounded-lg border text-sm ${slot === s ? "text-white" : "border-[#d0d5dd]"}`} style={slot === s ? btn : {}}>{fmtTime(s)}</button>)}
                  </div>
                </>
              )}
            </section>
          )}

          {slot && (
            <section className="space-y-3">
              <h2 className="font-semibold">3. Your details</h2>
              <p className="text-sm text-[#475467]">{type.name}, {fmtLong(slot)}</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Full name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
                <Field label="Email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
                {type.collectPhone && <Field label="Mobile, for a text reminder (optional)" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />}
              </div>
              {type.questions.map((q) => <Field key={q.id} label={`${q.label}${q.required ? "" : " (optional)"}`} value={form.answers[q.id] || ""} onChange={(v) => setForm({ ...form, answers: { ...form.answers, [q.id]: v } })} />)}
              <label className="block"><span className="text-sm text-[#344054]">Anything we should know? (optional)</span><textarea rows={3} className="mt-1 w-full border border-[#d0d5dd] rounded-lg px-3 py-2" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
              <input tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              <label className="flex items-start gap-2 text-sm text-[#475467]"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} className="mt-1" /> Send me occasional news and offers from {p.businessName}. You can unsubscribe at any time.</label>
              {p.privacyNote && <p className="text-xs text-[#6b7280]">{p.privacyNote}</p>}
              <button disabled={busy || !form.name || !form.email || type.questions.some((q) => q.required && !form.answers[q.id])} onClick={book} className="w-full sm:w-auto px-6 py-3 rounded-lg font-medium disabled:opacity-40" style={btn}>{busy ? "Booking…" : type.requiresConfirmation ? "Request this time" : "Confirm booking"}</button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return <label className="block"><span className="text-sm text-[#344054]">{label}</span><input type={type} className="mt-1 w-full border border-[#d0d5dd] rounded-lg px-3 py-2" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
