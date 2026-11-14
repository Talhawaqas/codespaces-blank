"use client";

// src/components/business/AppointmentsView.js
//
// Appointment Calendar (Business Workspace, Business and Enterprise plans).
// Overview (stats cards, upcoming list with Join buttons, calendar sync),
// Calendar (day / week / month; mine, team or department), Book (staff
// books for a customer), Enquiries, Availability (weekly hours, time off,
// Google/Outlook sync) and Setup (appointment types, booking pages,
// settings, roles). Same self-contained view pattern as EducationView.js;
// every permission is enforced server-side (src/lib/engagement/*).

import { useState, useEffect, useCallback, useMemo } from "react";
import EmptyState from "../EmptyState";
import { useErpSection } from "./erp/ErpNavContext";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { data, status: res.status });
  return data;
}

const panel = "bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5";
const row = "flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3";
const input = "bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";
const primary = "text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40";
const ghost = "text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] disabled:opacity-40";
const muted = "text-[var(--inaya-text-muted)] text-[12px]";
const h3 = "text-[var(--inaya-text-primary)] font-semibold text-sm mb-3";
const h3n = "text-[var(--inaya-text-primary)] font-semibold text-sm";
const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const STATUS_STYLE = { PENDING: "text-amber-300 bg-amber-400/10", CONFIRMED: "text-[#00f2fe] bg-[#00f2fe]/10", COMPLETED: "text-emerald-300 bg-emerald-400/10", CANCELLED: "text-red-300 bg-red-400/10", NO_SHOW: "text-orange-300 bg-orange-400/10" };
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const fmtFull = (d) => `${fmtDay(d)}, ${fmtTime(d)}`;
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const label = (s) => String(s || "").replace(/_/g, " ").toLowerCase();

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setData(await fn()); } catch (err) { setError(err.message); if (err.data?.upgrade) setData({ upgrade: true, error: err.message }); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return [data, load, error, setError];
}

function Change({ value }) {
  if (value === null || value === undefined) return <span className={muted}>new</span>;
  const up = value >= 0;
  return <span className={`text-[11px] font-bold ${up ? "text-emerald-300" : "text-red-300"}`}>{up ? "▲" : "▼"} {Math.abs(value)}%</span>;
}

function Badge({ status }) {
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${STATUS_STYLE[status] || ""}`}>{label(status)}</span>;
}

export default function AppointmentsView({ orgId, canManage, email }) {
  const TABS = [["overview", "Overview"], ["calendar", "Calendar"], ["book", "Book"], ["enquiries", "Enquiries"], ["availability", "My availability"], ["setup", "Setup"]];
  const [tab, setTab] = useErpSection("overview", TABS);
  const [options, , optErr] = useLoad(() => api(`/api/orgs/appointments/options?orgId=${orgId}`), [orgId]);
  const [types, reloadTypes] = useLoad(() => api(`/api/orgs/appointments/types?orgId=${orgId}`), [orgId]);
  const [openId, setOpenId] = useState(() => { try { return new URLSearchParams(window.location.search).get("appointment"); } catch { return null; } });

  if (options?.upgrade || /Business and Enterprise/.test(optErr || "")) {
    return <EmptyState title="Appointments are part of Business and Enterprise" description="Online booking, team calendars, reminders by email and SMS, and Google/Outlook sync. Upgrade in Settings → Billing to turn them on." />;
  }
  const isManager = !!options?.canManage;
  const ctx = { orgId, email, options, isManager, types: types?.types || [], reloadTypes, openAppointment: setOpenId };
  const visibleTabs = TABS.filter(([k]) => (k === "enquiries" || k === "setup" ? isManager : true));

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap" data-erp-tabs>
        {visibleTabs.map(([key, text]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{text}</button>
        ))}
      </div>
      {optErr && !options?.upgrade && <p className="text-red-300 text-sm">{optErr}</p>}
      {tab === "overview" && <Overview {...ctx} goto={setTab} />}
      {tab === "calendar" && <CalendarTab {...ctx} />}
      {tab === "book" && <BookTab {...ctx} />}
      {tab === "enquiries" && isManager && <EnquiriesTab {...ctx} />}
      {tab === "availability" && <AvailabilityTab {...ctx} />}
      {tab === "setup" && isManager && <SetupTab {...ctx} canManageOrg={canManage} />}
      {openId && <AppointmentDrawer {...ctx} id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ orgId, isManager, openAppointment, goto }) {
  const [scope, setScope] = useState("mine");
  const [period, setPeriod] = useState("month");
  const [data, reload, err] = useLoad(() => api(`/api/orgs/appointments/dashboard?orgId=${orgId}&scope=${scope}&period=${period}&timeZone=${encodeURIComponent(browserTz())}`), [orgId, scope, period]);
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  const cards = data?.cards;
  const CARD_DEFS = [["total", "Total appointments"], ["completed", "Completed"], ["upcomingToday", "Upcoming today"], ["customersEngaged", "Customers engaged"]];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {isManager && <select className={input} value={scope} onChange={(e) => setScope(e.target.value)}><option value="mine">My calendar</option><option value="team">Whole team</option></select>}
        <select className={input} value={period} onChange={(e) => setPeriod(e.target.value)}><option value="week">Last 7 days</option><option value="month">Last 30 days</option><option value="quarter">Last 90 days</option></select>
        <span className={muted}>Change compares with the previous period of the same length.</span>
      </div>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {CARD_DEFS.map(([k, t]) => (
          <div key={k} className={panel}>
            <p className={muted}>{t}</p>
            <div className="flex items-end justify-between mt-2">
              <span className="text-2xl font-bold text-[var(--inaya-text-primary)]">{cards ? cards[k].value.toLocaleString() : "…"}</span>
              {cards && <Change value={cards[k].change} />}
            </div>
          </div>
        ))}
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className={`${panel} lg:col-span-2`}>
          <div className="flex items-center justify-between mb-3"><h3 className={h3n}>Upcoming</h3><button className={ghost} onClick={() => goto("calendar")}>Open calendar</button></div>
          {!data ? <p className={muted}>Loading…</p> : data.upcoming.length === 0 ? <p className={muted}>Nothing booked yet. Share your booking page or book someone in from the Book tab.</p> : (
            <div className="space-y-2">
              {data.upcoming.map((a) => (
                <div key={a.id} className={row}>
                  <button className="text-left min-w-0 flex-1" onClick={() => openAppointment(a.id)}>
                    <p className="text-sm text-[var(--inaya-text-primary)] truncate">{a.customer.name} · {a.typeName}</p>
                    <p className={muted}>{fmtFull(a.start)} – {fmtTime(a.end)}{isManager && scope === "team" ? ` · ${a.staffEmail}` : ""}</p>
                  </button>
                  <Badge status={a.status} />
                  {a.location?.joinLink ? <a href={a.location.joinLink} target="_blank" rel="noreferrer" className={a.joinable ? primary : ghost}>Join</a> : <span className={muted}>{label(a.location?.kind)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div className={panel}>
            <h3 className={h3}>Calendar sync</h3>
            {data && <>
              <p className="text-sm text-[var(--inaya-text-primary)]">{data.sync.feedEnabled ? "✓ Your appointments appear in your calendar app" : "Your appointments aren't in your calendar app yet"}</p>
              <p className="text-sm text-[var(--inaya-text-primary)] mt-1">{data.sync.importConnected ? `✓ Busy times read from your calendar${data.sync.importLastSyncAt ? ` (checked ${fmtTime(data.sync.importLastSyncAt)})` : ""}` : "Your own calendar's busy times aren't connected"}</p>
              {data.sync.importError && <p className="text-red-300 text-xs mt-1">{data.sync.importError}</p>}
              <button className={`${ghost} mt-3`} onClick={() => goto("availability")}>Google / Outlook sync</button>
            </>}
          </div>
          <div className={panel}>
            <h3 className={h3}>Booking page</h3>
            {data && <>
              <p className="text-sm text-[var(--inaya-text-primary)]">Booking completion: <strong>{data.rates.bookingCompletion === null ? "—" : `${data.rates.bookingCompletion}%`}</strong> <span className={muted}>(target 80%)</span></p>
              <p className={muted}>{data.funnel.views} visits · {data.funnel.starts} started · {data.funnel.completions} booked · {data.funnel.enquiries} enquiries</p>
              <p className={`${muted} mt-2`}>No-shows: {data.rates.noShow === null ? "—" : `${data.rates.noShow}%`} · Cancellations: {data.rates.cancellation === null ? "—" : `${data.rates.cancellation}%`}</p>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ calendar

function CalendarTab({ orgId, options, isManager, openAppointment }) {
  const [mode, setMode] = useState("week");
  const [scope, setScope] = useState("mine");
  const [departmentId, setDepartmentId] = useState("");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [departments] = useLoad(() => api(`/api/orgs/departments?orgId=${orgId}`).catch(() => ({ departments: [] })), [orgId]);
  const range = useMemo(() => {
    if (mode === "day") return { from: anchor, to: addDays(anchor, 1) };
    if (mode === "week") { const s = startOfWeek(anchor); return { from: s, to: addDays(s, 7) }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1); const s = startOfWeek(first); return { from: s, to: addDays(s, 42) };
  }, [mode, anchor]);
  const q = `orgId=${orgId}&scope=${scope}${scope === "department" ? `&departmentId=${departmentId}` : ""}&from=${range.from.toISOString()}&to=${range.to.toISOString()}`;
  const [data, , err] = useLoad(() => (scope === "department" && !departmentId ? Promise.resolve({ appointments: [] }) : api(`/api/orgs/appointments/appointments?${q}`)), [q]);
  const appts = (data?.appointments || []).filter((a) => a.status !== "CANCELLED");
  const byDay = useMemo(() => { const m = new Map(); for (const a of appts) { const k = dayKey(a.start); if (!m.has(k)) m.set(k, []); m.get(k).push(a); } return m; }, [appts]);
  const step = (n) => setAnchor((d) => (mode === "day" ? addDays(d, n) : mode === "week" ? addDays(d, 7 * n) : new Date(d.getFullYear(), d.getMonth() + n, 1)));
  const title = mode === "month" ? anchor.toLocaleDateString([], { month: "long", year: "numeric" }) : mode === "week" ? `${fmtDay(range.from)} – ${fmtDay(addDays(range.to, -1))}` : anchor.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const deptList = departments?.departments || [];

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex bg-black/20 rounded-lg p-1">{["day", "week", "month"].map((m) => <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 text-xs font-bold uppercase rounded ${mode === m ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{m}</button>)}</div>
        <select className={input} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="mine">Personal</option>
          {isManager && <option value="team">Team</option>}
          <option value="department">Department</option>
        </select>
        {scope === "department" && <select className={input} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">Choose department…</option>{deptList.map((d) => <option key={d._id || d.id} value={d._id || d.id}>{d.name}</option>)}</select>}
        <div className="flex items-center gap-1 ml-auto">
          <button className={ghost} onClick={() => step(-1)}>‹</button>
          <button className={ghost} onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
          <button className={ghost} onClick={() => step(1)}>›</button>
        </div>
        <span className="text-sm font-semibold text-[var(--inaya-text-primary)] w-full sm:w-auto">{title}</span>
      </div>
      {err && <p className="text-red-300 text-sm mb-2">{err}</p>}
      {mode === "month" ? (
        <div className="grid grid-cols-7 gap-px bg-white/5 rounded-lg overflow-hidden">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-[var(--inaya-surface)] text-center text-[11px] py-1 text-[var(--inaya-text-muted)]">{d}</div>)}
          {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map((d) => {
            const list = byDay.get(dayKey(d)) || []; const other = d.getMonth() !== anchor.getMonth(); const isToday = dayKey(d) === dayKey(new Date());
            return (
              <div key={d.toISOString()} className={`bg-[var(--inaya-surface)] min-h-[84px] p-1 ${other ? "opacity-40" : ""}`}>
                <button onClick={() => { setAnchor(startOfDay(d)); setMode("day"); }} className={`text-[11px] ${isToday ? "text-[#00f2fe] font-bold" : "text-[var(--inaya-text-muted)]"}`}>{d.getDate()}</button>
                {list.slice(0, 3).map((a) => <button key={a.id} onClick={() => openAppointment(a.id)} className="block w-full text-left truncate text-[10px] mt-0.5 px-1 rounded bg-[#00f2fe]/10 text-[var(--inaya-text-primary)]">{fmtTime(a.start)} {a.customer.name}</button>)}
                {list.length > 3 && <p className="text-[10px] text-[var(--inaya-text-muted)]">+{list.length - 3} more</p>}
              </div>
            );
          })}
        </div>
      ) : (
        <TimeGrid days={mode === "day" ? [range.from] : Array.from({ length: 7 }, (_, i) => addDays(range.from, i))} byDay={byDay} onOpen={openAppointment} showStaff={scope !== "mine"} />
      )}
      {appts.length === 0 && data && <p className={`${muted} mt-3`}>No appointments in this range.</p>}
      {options && <p className={`${muted} mt-3`}>Times are shown in your time zone ({browserTz()}).</p>}
    </div>
  );
}

function TimeGrid({ days, byDay, onOpen, showStaff }) {
  // 07:00-20:00 by default, stretched to include every appointment shown (bookings from other time zones can fall at night).
  const HOUR = 44;
  const shown = days.flatMap((d) => byDay.get(dayKey(d)) || []);
  const START = Math.min(7, ...shown.map((a) => new Date(a.start).getHours()));
  const END = Math.max(20, ...shown.map((a) => { const e = new Date(a.end); const h = e.getHours() + (e.getMinutes() > 0 ? 1 : 0); return dayKey(e) !== dayKey(a.start) ? 24 : h; }));
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `48px repeat(${days.length}, minmax(0,1fr))` }}>
        <div />
        {days.map((d) => <div key={d.toISOString()} className={`text-center text-[11px] pb-1 ${dayKey(d) === dayKey(new Date()) ? "text-[#00f2fe] font-bold" : "text-[var(--inaya-text-muted)]"}`}>{fmtDay(d)}</div>)}
        <div className="relative" style={{ height: (END - START) * HOUR }}>
          {Array.from({ length: END - START }, (_, i) => <div key={i} className="absolute right-1 text-[10px] text-[var(--inaya-text-muted)]" style={{ top: i * HOUR - 6 }}>{String(START + i).padStart(2, "0")}:00</div>)}
        </div>
        {days.map((d) => (
          <div key={d.toISOString()} className="relative border-l border-white/5" style={{ height: (END - START) * HOUR }}>
            {Array.from({ length: END - START }, (_, i) => <div key={i} className="absolute left-0 right-0 border-t border-white/5" style={{ top: i * HOUR }} />)}
            {(byDay.get(dayKey(d)) || []).map((a) => {
              const s = new Date(a.start), e = new Date(a.end);
              const top = Math.max(0, ((s.getHours() + s.getMinutes() / 60) - START) * HOUR);
              const h = Math.max(18, ((e - s) / 3600000) * HOUR - 2);
              return (
                <button key={a.id} onClick={() => onOpen(a.id)} className={`absolute left-1 right-1 rounded-md px-1.5 py-0.5 text-left overflow-hidden border ${a.status === "PENDING" ? "border-amber-400/40 bg-amber-400/10" : "border-[#00f2fe]/30 bg-[#00f2fe]/10"}`} style={{ top, height: h }}>
                  <p className="text-[10px] font-semibold text-[var(--inaya-text-primary)] truncate">{fmtTime(a.start)} {a.customer.name}</p>
                  <p className="text-[10px] text-[var(--inaya-text-muted)] truncate">{a.typeName}{showStaff ? ` · ${a.staffEmail}` : ""}</p>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- drawer

function AppointmentDrawer({ orgId, id, onClose }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/appointments/appointments/${id}?orgId=${orgId}`), [orgId, id]);
  const [notes, setNotes] = useState(null);
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [resched, setResched] = useState(false);
  const [docId, setDocId] = useState("");
  const a = data?.appointment;
  useEffect(() => { if (a) { setNotes(a.notes || ""); setOutcome(a.outcome || ""); } }, [a?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, ok) => { setBusy(true); setMsg(""); try { await fn(); setMsg(ok); await reload(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } };
  const status = (s, extra = {}) => act(() => api(`/api/orgs/appointments/appointments/${id}/status`, { method: "POST", body: JSON.stringify({ orgId, status: s, ...extra }) }), `Marked ${label(s)}.`);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md h-full overflow-y-auto bg-[var(--inaya-bg,#0b0f17)] border-l border-white/10 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold text-[var(--inaya-text-primary)]">Appointment</h2><button className={ghost} onClick={onClose}>Close</button></div>
        {err && <p className="text-red-300 text-sm">{err}</p>}
        {!a ? <p className={muted}>Loading…</p> : <>
          <div className="space-y-1">
            <div className="flex items-center gap-2"><p className="text-[var(--inaya-text-primary)] font-semibold">{a.typeName}</p><Badge status={a.status} /></div>
            <p className="text-sm text-[var(--inaya-text-primary)]">{fmtFull(a.start)} – {fmtTime(a.end)}</p>
            <p className={muted}>Customer's time zone: {a.timeZone} · with {a.staffEmail}</p>
            <p className="text-sm text-[var(--inaya-text-primary)] mt-2">{a.customer.name} · <a className="underline" href={`mailto:${a.customer.email}`}>{a.customer.email}</a>{a.customerPhone ? ` · ${a.customerPhone}` : ""}</p>
            {a.contactId && <p className={muted}>Linked to the CRM contact. Completing this appointment logs the meeting there.</p>}
            {a.location && <p className="text-sm text-[var(--inaya-text-primary)]">{a.location.joinLink ? <a href={a.location.joinLink} target="_blank" rel="noreferrer" className={primary}>Join meeting</a> : `${label(a.location.kind)}${a.location.detail ? `: ${a.location.detail}` : ""}`}</p>}
            {a.customerNote && <p className="text-sm text-[var(--inaya-text-primary)] mt-2"><span className={muted}>Customer note:</span> {a.customerNote}</p>}
            {a.answers?.filter((x) => x.value).map((x) => <p key={x.id} className="text-sm text-[var(--inaya-text-primary)]"><span className={muted}>{x.label}:</span> {x.value}</p>)}
          </div>
          <div className="flex flex-wrap gap-2">
            {a.status === "PENDING" && <button disabled={busy} className={primary} onClick={() => status("CONFIRMED")}>Confirm</button>}
            {["PENDING", "CONFIRMED"].includes(a.status) && <button disabled={busy} className={ghost} onClick={() => setResched((v) => !v)}>Reschedule</button>}
            {a.status === "CONFIRMED" && new Date(a.start) <= new Date() && <button disabled={busy} className={primary} onClick={() => status("COMPLETED", { outcome })}>Mark completed</button>}
            {a.status === "CONFIRMED" && new Date(a.start) <= new Date() && <button disabled={busy} className={ghost} onClick={() => status("NO_SHOW")}>No-show</button>}
            {a.status === "NO_SHOW" && <button disabled={busy} className={ghost} onClick={() => status("COMPLETED", { outcome })}>Actually held</button>}
            {["PENDING", "CONFIRMED"].includes(a.status) && <button disabled={busy} className={ghost} onClick={() => { const reason = window.prompt("Reason for cancelling (sent to the customer):", ""); if (reason !== null) status("CANCELLED", { reason }); }}>Cancel</button>}
          </div>
          {resched && <Rescheduler orgId={orgId} appt={a} onDone={() => { setResched(false); reload(); setMsg("Moved. The customer has the new time and invite."); }} />}
          {msg && <p className="text-sm text-[var(--inaya-text-primary)]">{msg}</p>}
          <div>
            <p className={h3}>Meeting notes <span className={muted}>(private, encrypted)</span></p>
            <textarea className={`${input} w-full`} rows={5} value={notes ?? ""} onChange={(e) => setNotes(e.target.value)} />
            <p className={`${h3} mt-3`}>Outcome <span className={muted}>(goes on the CRM record when completed)</span></p>
            <textarea className={`${input} w-full`} rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
            <button disabled={busy} className={`${ghost} mt-2`} onClick={() => act(() => api(`/api/orgs/appointments/appointments/${id}`, { method: "PATCH", body: JSON.stringify({ orgId, notes, outcome }) }), "Saved.")}>Save notes</button>
          </div>
          <div>
            <p className={h3}>Attachments</p>
            {(a.attachments || []).map((x) => <div key={x.id} className={`${row} mb-1`}><span className="text-sm text-[var(--inaya-text-primary)] truncate">{x.label}</span><button className={ghost} onClick={() => act(() => api(`/api/orgs/appointments/appointments/${id}`, { method: "PATCH", body: JSON.stringify({ orgId, removeAttachmentId: x.id }) }), "Removed.")}>Remove</button></div>)}
            <div className="flex gap-2"><input className={`${input} flex-1`} placeholder="Document ID from Documents" value={docId} onChange={(e) => setDocId(e.target.value)} /><button disabled={!docId || busy} className={ghost} onClick={() => act(() => api(`/api/orgs/appointments/appointments/${id}`, { method: "PATCH", body: JSON.stringify({ orgId, addAttachment: { documentId: docId.trim() } }) }).then(() => setDocId("")), "Attached.")}>Attach</button></div>
            <p className={`${muted} mt-1`}>Attach files already uploaded to Documents (they stay encrypted there).</p>
          </div>
          <div>
            <p className={h3}>Reminders</p>
            {(a.reminders || []).filter((r) => r.channel !== "staff_prompt").map((r) => <p key={r.id} className={muted}>{r.channel.toUpperCase()} {r.offsetMinutes >= 60 ? `${r.offsetMinutes / 60} h` : `${r.offsetMinutes} min`} before: {r.sentAt ? (r.error ? `not sent (${r.error})` : `sent ${fmtFull(r.sentAt)}`) : `due ${fmtFull(r.dueAt)}`}</p>)}
          </div>
          <div>
            <p className={h3}>History</p>
            {(a.history || []).map((h, i) => <p key={i} className={muted}>{fmtFull(h.at)} · {label(h.action)} · {h.by}{h.reason ? ` · ${h.reason}` : ""}</p>)}
          </div>
        </>}
      </div>
    </div>
  );
}

function SlotPicker({ slots, value, onChange }) {
  const grouped = useMemo(() => { const m = new Map(); for (const s of slots) { const k = dayKey(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return [...m.entries()]; }, [slots]);
  if (!slots.length) return <p className={muted}>No free times in this range. Try the next week.</p>;
  return (
    <div className="space-y-2 max-h-72 overflow-y-auto">
      {grouped.map(([k, list]) => (
        <div key={k}><p className={muted}>{fmtDay(list[0])}</p>
          <div className="flex flex-wrap gap-1 mt-1">{list.map((s) => <button key={s} onClick={() => onChange(s)} className={`px-2 py-1 text-xs rounded border ${value === s ? "border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10" : "border-white/10 text-[var(--inaya-text-primary)]"}`}>{fmtTime(s)}</button>)}</div>
        </div>
      ))}
    </div>
  );
}

function Rescheduler({ orgId, appt, onDone }) {
  const [from, setFrom] = useState(() => startOfDay(new Date()));
  const [slots, setSlots] = useState(null);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!appt.typeId) return;
    api(`/api/orgs/appointments/types/${appt.typeId}/slots?orgId=${orgId}&staffEmail=${encodeURIComponent(appt.staffEmail)}&from=${from.toISOString()}&to=${addDays(from, 7).toISOString()}`).then((r) => setSlots(r.slots.map((s) => s.start))).catch((e) => setErr(e.message));
  }, [orgId, appt.typeId, appt.staffEmail, from]);
  const save = async () => { try { setErr(""); await api(`/api/orgs/appointments/appointments/${appt.id}/reschedule`, { method: "POST", body: JSON.stringify({ orgId, start: pick }) }); onDone(); } catch (e) { setErr(e.message); } };
  return (
    <div className={`${row} flex-col items-stretch`}>
      <div className="flex justify-between"><button className={ghost} onClick={() => setFrom((d) => addDays(d, -7))} disabled={from <= startOfDay(new Date())}>‹ Earlier</button><button className={ghost} onClick={() => setFrom((d) => addDays(d, 7))}>Later ›</button></div>
      {slots ? <SlotPicker slots={slots} value={pick} onChange={setPick} /> : <p className={muted}>Loading free times…</p>}
      {err && <p className="text-red-300 text-xs">{err}</p>}
      <button className={primary} disabled={!pick} onClick={save}>Move to {pick ? fmtFull(pick) : "…"}</button>
    </div>
  );
}

// -------------------------------------------------------------------- book

function BookTab({ orgId, email, types, isManager, openAppointment }) {
  const active = types.filter((t) => !t.archived);
  const [typeId, setTypeId] = useState("");
  const type = active.find((t) => t.id === typeId);
  const [staff, setStaff] = useState("");
  const [from, setFrom] = useState(() => startOfDay(new Date()));
  const [slots, setSlots] = useState(null);
  const [pick, setPick] = useState("");
  const [cust, setCust] = useState({ name: "", email: "", phone: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => { if (type) setStaff(type.staffEmails.includes(email) ? email : type.staffEmails[0]); setPick(""); }, [typeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!type || !staff) return; setSlots(null);
    api(`/api/orgs/appointments/types/${type.id}/slots?orgId=${orgId}&staffEmail=${encodeURIComponent(staff)}&from=${from.toISOString()}&to=${addDays(from, 7).toISOString()}`).then((r) => setSlots(r.slots.map((s) => s.start))).catch((e) => setMsg(e.message));
  }, [orgId, type, staff, from]);
  const book = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api(`/api/orgs/appointments/appointments`, { method: "POST", body: JSON.stringify({ orgId, typeId, staffEmail: staff, start: pick, customer: { name: cust.name, email: cust.email, phone: cust.phone }, note: cust.note, timeZone: browserTz() }) });
      setMsg(`Booked for ${fmtFull(r.appointment.start)}. ${r.emailSent ? "The customer has a confirmation and calendar invite." : "The confirmation email could not be sent."}`);
      setPick(""); setCust({ name: "", email: "", phone: "", note: "" }); openAppointment(r.appointment.id);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  if (!active.length) return <EmptyState title="No appointment types yet" description={isManager ? "Create one in Setup → Appointment types (for example a 30-minute consultation)." : "Ask a calendar manager to create an appointment type."} />;
  const staffChoices = type ? (isManager ? type.staffEmails : type.staffEmails.filter((e) => e === email)) : [];
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className={panel}>
        <h3 className={h3}>1. Choose a time</h3>
        <select className={`${input} w-full mb-2`} value={typeId} onChange={(e) => setTypeId(e.target.value)}><option value="">Appointment type…</option>{active.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.durationMinutes} min)</option>)}</select>
        {type && (staffChoices.length ? <select className={`${input} w-full mb-3`} value={staff} onChange={(e) => setStaff(e.target.value)}>{staffChoices.map((s) => <option key={s} value={s}>{s}</option>)}</select> : <p className="text-amber-300 text-sm mb-2">You don&apos;t take this appointment type. A calendar manager can book it for the team.</p>)}
        {type && staffChoices.length > 0 && <>
          <div className="flex justify-between mb-2"><button className={ghost} disabled={from <= startOfDay(new Date())} onClick={() => setFrom((d) => addDays(d, -7))}>‹ Earlier</button><span className={muted}>{fmtDay(from)} – {fmtDay(addDays(from, 6))}</span><button className={ghost} onClick={() => setFrom((d) => addDays(d, 7))}>Later ›</button></div>
          {slots ? <SlotPicker slots={slots} value={pick} onChange={setPick} /> : <p className={muted}>Loading free times…</p>}
        </>}
      </div>
      <div className={panel}>
        <h3 className={h3}>2. Customer</h3>
        <div className="space-y-2">
          <input className={`${input} w-full`} placeholder="Full name" value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
          <input className={`${input} w-full`} placeholder="Email" type="email" value={cust.email} onChange={(e) => setCust({ ...cust, email: e.target.value })} />
          <input className={`${input} w-full`} placeholder="Phone for SMS reminders (optional)" value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
          <textarea className={`${input} w-full`} rows={3} placeholder="Note (visible to the team)" value={cust.note} onChange={(e) => setCust({ ...cust, note: e.target.value })} />
        </div>
        <p className={`${muted} mt-2`}>The customer is added to the CRM as a lead if they aren&apos;t already there, and gets a confirmation email with a calendar invite and a link to reschedule or cancel.</p>
        <button className={`${primary} mt-3`} disabled={busy || !pick || !cust.name || !cust.email} onClick={book}>{pick ? `Book ${fmtFull(pick)}` : "Choose a time first"}</button>
        {msg && <p className="text-sm text-[var(--inaya-text-primary)] mt-2">{msg}</p>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- enquiries

function EnquiriesTab({ orgId }) {
  const [status, setStatus] = useState("NEW");
  const [data, reload, err] = useLoad(() => api(`/api/orgs/appointments/enquiries?orgId=${orgId}${status ? `&status=${status}` : ""}`), [orgId, status]);
  const set = async (id, s) => { await api(`/api/orgs/appointments/enquiries/${id}`, { method: "PATCH", body: JSON.stringify({ orgId, status: s }) }).catch(() => {}); reload(); };
  return (
    <div className={panel}>
      <div className="flex items-center gap-2 mb-3"><h3 className={h3n}>Enquiries</h3>
        <select className={input} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["NEW", "CONTACTED", "BOOKED", "CLOSED"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      </div>
      <p className={`${muted} mb-3`}>From the enquiry form on your booking pages. Each one is already a CRM lead and has had the welcome email.</p>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {data?.enquiries?.length === 0 && <p className={muted}>No enquiries here.</p>}
      <div className="space-y-2">
        {(data?.enquiries || []).map((q) => (
          <div key={q.id} className={`${row} flex-col items-stretch`}>
            <div className="flex justify-between gap-2"><p className="text-sm text-[var(--inaya-text-primary)] font-semibold">{q.name}{q.company ? ` · ${q.company}` : ""}</p><span className={muted}>{fmtFull(q.createdAt)}</span></div>
            <p className={muted}><a className="underline" href={`mailto:${q.email}`}>{q.email}</a>{q.phone ? ` · ${q.phone}` : ""}</p>
            <p className="text-sm text-[var(--inaya-text-primary)] whitespace-pre-wrap">{q.message}</p>
            <div className="flex gap-2">{["CONTACTED", "BOOKED", "CLOSED"].filter((s) => s !== q.status).map((s) => <button key={s} className={ghost} onClick={() => set(q.id, s)}>Mark {label(s)}</button>)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ availability

function AvailabilityTab({ orgId, email, isManager, options }) {
  const [who, setWho] = useState(email);
  const [data, reload, err] = useLoad(() => api(`/api/orgs/appointments/availability?orgId=${orgId}&staffEmail=${encodeURIComponent(who)}`), [orgId, who]);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState("");
  const [feed, setFeed] = useState(null);
  const [importUrl, setImportUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data?.availability) setDraft(JSON.parse(JSON.stringify(data.availability))); }, [data]);
  const zones = useMemo(() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC", "Asia/Karachi", "Asia/Dubai", "Europe/London", "America/New_York"]; } }, []);
  if (!draft) return <p className={muted}>{err || "Loading…"}</p>;
  const setRange = (day, i, field, v) => { const w = { ...draft.weekly }; w[day] = w[day].map((r, j) => (j === i ? { ...r, [field]: v } : r)); setDraft({ ...draft, weekly: w }); };
  const save = async () => { setBusy(true); setMsg(""); try { await api(`/api/orgs/appointments/availability`, { method: "PUT", body: JSON.stringify({ orgId, staffEmail: who, timeZone: draft.timeZone, weekly: draft.weekly, timeOff: draft.timeOff, bookable: draft.bookable }) }); setMsg("Saved."); reload(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } };
  const call = async (path, method, body, ok) => { setBusy(true); setMsg(""); try { const r = await api(`/api/orgs/appointments/${path}`, { method, body: JSON.stringify({ orgId, staffEmail: who, ...body }) }); setMsg(ok(r)); reload(); return r; } catch (e) { setMsg(e.message); return null; } finally { setBusy(false); } };
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className={panel}>
        <div className="flex items-center justify-between mb-3"><h3 className={h3n}>Working hours</h3>
          {isManager && options?.members?.length > 0 && <select className={input} value={who} onChange={(e) => setWho(e.target.value)}>{options.members.map((m) => <option key={m.email} value={m.email}>{m.email}</option>)}</select>}
        </div>
        <label className={muted}>Time zone</label>
        <select className={`${input} w-full mb-3`} value={draft.timeZone} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>
        {DAYS.map(([k, name]) => (
          <div key={k} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-white/5">
            <span className="w-24 text-sm text-[var(--inaya-text-primary)]">{name}</span>
            {(draft.weekly[k] || []).length === 0 && <span className={muted}>Unavailable</span>}
            {(draft.weekly[k] || []).map((r, i) => (
              <span key={i} className="flex items-center gap-1">
                <input type="time" className={input} value={r.start} onChange={(e) => setRange(k, i, "start", e.target.value)} />–<input type="time" className={input} value={r.end} onChange={(e) => setRange(k, i, "end", e.target.value)} />
                <button className={ghost} onClick={() => setDraft({ ...draft, weekly: { ...draft.weekly, [k]: draft.weekly[k].filter((_, j) => j !== i) } })}>×</button>
              </span>
            ))}
            <button className={ghost} onClick={() => setDraft({ ...draft, weekly: { ...draft.weekly, [k]: [...(draft.weekly[k] || []), { start: "09:00", end: "17:00" }] } })}>+ Hours</button>
          </div>
        ))}
        <label className="flex items-center gap-2 mt-3 text-sm text-[var(--inaya-text-primary)]"><input type="checkbox" checked={draft.bookable !== false} onChange={(e) => setDraft({ ...draft, bookable: e.target.checked })} /> Accept bookings</label>
        <h3 className={`${h3} mt-4`}>Time off</h3>
        {(draft.timeOff || []).map((t, i) => <div key={i} className={`${row} mb-1`}><span className="text-sm text-[var(--inaya-text-primary)]">{fmtFull(t.start)} → {fmtFull(t.end)} {t.reason}</span><button className={ghost} onClick={() => setDraft({ ...draft, timeOff: draft.timeOff.filter((_, j) => j !== i) })}>Remove</button></div>)}
        <TimeOffAdder onAdd={(t) => setDraft({ ...draft, timeOff: [...(draft.timeOff || []), t] })} />
        <button className={`${primary} mt-4`} disabled={busy} onClick={save}>Save availability</button>
        {msg && <p className="text-sm text-[var(--inaya-text-primary)] mt-2">{msg}</p>}
      </div>
      <div className="space-y-4">
        <div className={panel}>
          <h3 className={h3}>Show my appointments in Google Calendar or Outlook</h3>
          <p className={muted}>Creates a private calendar address. Add it once and new bookings appear automatically (calendar apps refresh it every few hours; Outlook sometimes sooner).</p>
          {feed ? (
            <div className="mt-3 space-y-2">
              <input readOnly className={`${input} w-full`} value={feed.feedUrl} onFocus={(e) => e.target.select()} />
              <p className={muted}><strong>Google Calendar:</strong> Other calendars → + → From URL → paste. <strong>Outlook:</strong> Add calendar → Subscribe from web → paste.</p>
              <p className="text-amber-300 text-xs">{feed.note} This address is shown once.</p>
            </div>
          ) : (
            <div className="flex gap-2 mt-3">
              <button className={primary} disabled={busy} onClick={async () => { const r = await call("sync/feed", "POST", {}, () => "Calendar address created."); if (r) setFeed(r); }}>{data.availability.feed.enabled ? "Create a new address" : "Create calendar address"}</button>
              {data.availability.feed.enabled && <button className={ghost} disabled={busy} onClick={() => call("sync/feed", "DELETE", {}, () => "Calendar address turned off.")}>Turn off</button>}
            </div>
          )}
          {data.availability.feed.enabled && !feed && <p className={`${muted} mt-2`}>✓ An address is active. Creating a new one stops the old one working.</p>}
        </div>
        <div className={panel}>
          <h3 className={h3}>Block times when I&apos;m busy in my own calendar</h3>
          <p className={muted}>Paste your calendar&apos;s secret iCal address. We only read busy times (never titles or guests) and check every 15 minutes.</p>
          <p className={`${muted} mt-1`}><strong>Google:</strong> Settings → your calendar → Integrate calendar → Secret address in iCal format. <strong>Outlook:</strong> Settings → Calendar → Shared calendars → Publish a calendar → ICS link.</p>
          {data.availability.calendarImport.connected ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-[var(--inaya-text-primary)]">✓ Connected · {data.availability.calendarImport.busyBlocks} busy blocks · checked {data.availability.calendarImport.lastSyncAt ? fmtFull(data.availability.calendarImport.lastSyncAt) : "—"}</p>
              {data.availability.calendarImport.lastError && <p className="text-red-300 text-xs">{data.availability.calendarImport.lastError}</p>}
              <div className="flex gap-2"><button className={ghost} disabled={busy} onClick={() => call("sync/import/refresh", "POST", {}, (r) => (r.error ? r.error : `Checked: ${r.busyBlocks} busy blocks.`))}>Check now</button><button className={ghost} disabled={busy} onClick={() => call("sync/import", "DELETE", {}, () => "Disconnected.")}>Disconnect</button></div>
            </div>
          ) : (
            <div className="flex gap-2 mt-3"><input className={`${input} flex-1`} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} /><button className={primary} disabled={busy || !importUrl} onClick={async () => { const r = await call("sync/import", "POST", { url: importUrl }, (x) => `Connected: ${x.busyBlocks} busy blocks found in the next 90 days.`); if (r) setImportUrl(""); }}>Connect</button></div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimeOffAdder({ onAdd }) {
  const [s, setS] = useState(""); const [e, setE] = useState(""); const [r, setR] = useState("");
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input type="datetime-local" className={input} value={s} onChange={(x) => setS(x.target.value)} />
      <input type="datetime-local" className={input} value={e} onChange={(x) => setE(x.target.value)} />
      <input className={input} placeholder="Reason (optional)" value={r} onChange={(x) => setR(x.target.value)} />
      <button className={ghost} disabled={!s || !e || new Date(e) <= new Date(s)} onClick={() => { onAdd({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), reason: r }); setS(""); setE(""); setR(""); }}>Add</button>
    </div>
  );
}

// ------------------------------------------------------------------- setup

function SetupTab({ orgId, options, types, reloadTypes, canManageOrg }) {
  const [section, setSection] = useState("types");
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">{[["types", "Appointment types"], ["pages", "Booking pages"], ["settings", "Reminders & settings"], ...(canManageOrg ? [["roles", "Roles"]] : [])].map(([k, t]) => <button key={k} onClick={() => setSection(k)} className={`${ghost} ${section === k ? "!text-[#00f2fe] !border-[#00f2fe]/40" : ""}`}>{t}</button>)}</div>
      {section === "types" && <TypesSetup orgId={orgId} options={options} types={types} reload={reloadTypes} />}
      {section === "pages" && <PagesSetup orgId={orgId} types={types} />}
      {section === "settings" && <SettingsSetup orgId={orgId} options={options} />}
      {section === "roles" && <RolesSetup orgId={orgId} options={options} />}
    </div>
  );
}

const EMPTY_TYPE = { name: "", description: "", durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, minNoticeMinutes: 120, maxAdvanceDays: 60, slotStepMinutes: 0, dailyLimit: 0, location: "inaya_meet", locationDetail: "", staffEmails: [], assignment: "choose", useCase: "general", requiresConfirmation: false, collectPhone: true, questions: [] };

function TypesSetup({ orgId, options, types, reload }) {
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState("");
  const members = options?.members || [];
  const save = async () => {
    setMsg("");
    try {
      const body = { orgId, ...edit, durationMinutes: Number(edit.durationMinutes), bufferBeforeMinutes: Number(edit.bufferBeforeMinutes), bufferAfterMinutes: Number(edit.bufferAfterMinutes), minNoticeMinutes: Number(edit.minNoticeMinutes), maxAdvanceDays: Number(edit.maxAdvanceDays), slotStepMinutes: Number(edit.slotStepMinutes), dailyLimit: Number(edit.dailyLimit) };
      if (edit.id) await api(`/api/orgs/appointments/types/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api(`/api/orgs/appointments/types`, { method: "POST", body: JSON.stringify(body) });
      setEdit(null); reload();
    } catch (e) { setMsg(e.message); }
  };
  const fromUseCase = (k) => { const u = options?.useCases?.[k]; if (u) setEdit((x) => ({ ...x, useCase: k, name: x.name || u.typeName, durationMinutes: u.durationMinutes, location: u.location })); else setEdit((x) => ({ ...x, useCase: k })); };
  if (edit) return (
    <div className={panel}>
      <h3 className={h3}>{edit.id ? "Edit appointment type" : "New appointment type"}</h3>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1"><span className={muted}>Use case</span><select className={`${input} w-full`} value={edit.useCase} onChange={(e) => fromUseCase(e.target.value)}>{Object.entries(options?.useCases || {}).map(([k, u]) => <option key={k} value={k}>{u.label}</option>)}</select></label>
        <label className="space-y-1"><span className={muted}>Name</span><input className={`${input} w-full`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label className="space-y-1 sm:col-span-2"><span className={muted}>Description (shown on the booking page)</span><textarea className={`${input} w-full`} rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
        {[["durationMinutes", "Length (minutes)"], ["bufferBeforeMinutes", "Gap before (minutes)"], ["bufferAfterMinutes", "Gap after (minutes)"], ["minNoticeMinutes", "Minimum notice (minutes)"], ["maxAdvanceDays", "Book up to (days ahead)"], ["slotStepMinutes", "Start times every (minutes, 0 = length)"], ["dailyLimit", "Max per day per person (0 = no limit)"]].map(([k, t]) => (
          <label key={k} className="space-y-1"><span className={muted}>{t}</span><input type="number" className={`${input} w-full`} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></label>
        ))}
        <label className="space-y-1"><span className={muted}>Where</span><select className={`${input} w-full`} value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })}><option value="inaya_meet">Inaya Meet (link created automatically)</option><option value="video_url">Another video link</option><option value="phone">Phone call</option><option value="in_person">In person</option></select></label>
        {["video_url", "in_person"].includes(edit.location) && <label className="space-y-1"><span className={muted}>{edit.location === "video_url" ? "Meeting link (https://…)" : "Address"}</span><input className={`${input} w-full`} value={edit.locationDetail} onChange={(e) => setEdit({ ...edit, locationDetail: e.target.value })} /></label>}
        <label className="space-y-1"><span className={muted}>Who takes it</span><select className={`${input} w-full`} value={edit.assignment} onChange={(e) => setEdit({ ...edit, assignment: e.target.value })}><option value="choose">First free person (or customer chooses, if the page allows)</option><option value="round_robin">Round robin (spread evenly)</option></select></label>
      </div>
      <p className={`${muted} mt-3`}>Team members</p>
      <div className="flex flex-wrap gap-2 mt-1">{members.map((m) => <label key={m.email} className="flex items-center gap-1 text-sm text-[var(--inaya-text-primary)]"><input type="checkbox" checked={edit.staffEmails.includes(m.email)} onChange={(e) => setEdit({ ...edit, staffEmails: e.target.checked ? [...edit.staffEmails, m.email] : edit.staffEmails.filter((x) => x !== m.email) })} />{m.email}</label>)}</div>
      <div className="flex flex-wrap gap-4 mt-3 text-sm text-[var(--inaya-text-primary)]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={edit.requiresConfirmation} onChange={(e) => setEdit({ ...edit, requiresConfirmation: e.target.checked })} /> Bookings need our confirmation</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={edit.collectPhone} onChange={(e) => setEdit({ ...edit, collectPhone: e.target.checked })} /> Ask for a phone number (SMS reminders)</label>
      </div>
      <p className={`${muted} mt-3`}>Questions for the customer</p>
      {edit.questions.map((q, i) => <div key={i} className="flex gap-2 mt-1"><input className={`${input} flex-1`} value={q.label} onChange={(e) => setEdit({ ...edit, questions: edit.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /><label className="flex items-center gap-1 text-xs text-[var(--inaya-text-muted)]"><input type="checkbox" checked={q.required} onChange={(e) => setEdit({ ...edit, questions: edit.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />required</label><button className={ghost} onClick={() => setEdit({ ...edit, questions: edit.questions.filter((_, j) => j !== i) })}>×</button></div>)}
      <button className={`${ghost} mt-1`} onClick={() => setEdit({ ...edit, questions: [...edit.questions, { label: "", required: false }] })}>+ Question</button>
      <div className="flex gap-2 mt-4"><button className={primary} onClick={save}>Save</button><button className={ghost} onClick={() => setEdit(null)}>Cancel</button></div>
      {msg && <p className="text-red-300 text-sm mt-2">{msg}</p>}
    </div>
  );
  return (
    <div className={panel}>
      <div className="flex justify-between mb-3"><h3 className={h3n}>Appointment types</h3><button className={primary} onClick={() => setEdit({ ...EMPTY_TYPE })}>New type</button></div>
      {types.length === 0 && <p className={muted}>None yet. Start from a use case: patient visits, legal consultations, financial advisory, parent meetings or sales meetings.</p>}
      <div className="space-y-2">{types.map((t) => (
        <div key={t.id} className={row}>
          <div><p className="text-sm text-[var(--inaya-text-primary)]">{t.name} <span className={muted}>· {t.durationMinutes} min · {label(t.location)} · {t.staffEmails.length} people{t.assignment === "round_robin" ? " · round robin" : ""}</span></p><p className={muted}>{options?.useCases?.[t.useCase]?.label}</p></div>
          <div className="flex gap-2"><button className={ghost} onClick={() => setEdit({ ...EMPTY_TYPE, ...t })}>Edit</button><button className={ghost} onClick={async () => { await api(`/api/orgs/appointments/types/${t.id}`, { method: "PATCH", body: JSON.stringify({ orgId, archived: true }) }).catch(() => {}); reload(); }}>Archive</button></div>
        </div>
      ))}</div>
    </div>
  );
}

function PagesSetup({ orgId, types }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/appointments/pages?orgId=${orgId}`), [orgId]);
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState("");
  const save = async () => {
    setMsg("");
    try {
      const body = { orgId, slug: edit.slug, title: edit.title, intro: edit.intro, typeIds: edit.typeIds, active: edit.active, enquiryEnabled: edit.enquiryEnabled, showStaffChoice: edit.showStaffChoice, brandColor: edit.brandColor, privacyNote: edit.privacyNote };
      if (edit.id) await api(`/api/orgs/appointments/pages/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api(`/api/orgs/appointments/pages`, { method: "POST", body: JSON.stringify(body) });
      setEdit(null); reload();
    } catch (e) { setMsg(e.message); }
  };
  if (edit) return (
    <div className={panel}>
      <h3 className={h3}>{edit.id ? "Edit booking page" : "New booking page"}</h3>
      <div className="grid sm:grid-cols-2 gap-3">
        {!edit.id && <label className="space-y-1"><span className={muted}>Page address</span><div className="flex items-center gap-1"><span className={muted}>/book/</span><input className={`${input} flex-1`} value={edit.slug} onChange={(e) => setEdit({ ...edit, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></div></label>}
        <label className="space-y-1"><span className={muted}>Title</span><input className={`${input} w-full`} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
        <label className="space-y-1 sm:col-span-2"><span className={muted}>Introduction</span><textarea className={`${input} w-full`} rows={3} value={edit.intro} onChange={(e) => setEdit({ ...edit, intro: e.target.value })} /></label>
        <label className="space-y-1"><span className={muted}>Brand colour</span><input type="color" className="h-9 w-16 bg-transparent" value={edit.brandColor} onChange={(e) => setEdit({ ...edit, brandColor: e.target.value })} /></label>
        <label className="space-y-1 sm:col-span-2"><span className={muted}>Privacy note (optional)</span><input className={`${input} w-full`} value={edit.privacyNote} onChange={(e) => setEdit({ ...edit, privacyNote: e.target.value })} /></label>
      </div>
      <p className={`${muted} mt-3`}>Appointment types on this page</p>
      <div className="flex flex-wrap gap-3 mt-1">{types.map((t) => <label key={t.id} className="flex items-center gap-1 text-sm text-[var(--inaya-text-primary)]"><input type="checkbox" checked={edit.typeIds.includes(t.id)} onChange={(e) => setEdit({ ...edit, typeIds: e.target.checked ? [...edit.typeIds, t.id] : edit.typeIds.filter((x) => x !== t.id) })} />{t.name}</label>)}</div>
      <div className="flex flex-wrap gap-4 mt-3 text-sm text-[var(--inaya-text-primary)]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Published</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={edit.enquiryEnabled} onChange={(e) => setEdit({ ...edit, enquiryEnabled: e.target.checked })} /> Show an enquiry form</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={edit.showStaffChoice} onChange={(e) => setEdit({ ...edit, showStaffChoice: e.target.checked })} /> Let customers choose who they meet</label>
      </div>
      <div className="flex gap-2 mt-4"><button className={primary} onClick={save}>Save</button><button className={ghost} onClick={() => setEdit(null)}>Cancel</button></div>
      {msg && <p className="text-red-300 text-sm mt-2">{msg}</p>}
    </div>
  );
  return (
    <div className={panel}>
      <div className="flex justify-between mb-3"><h3 className={h3n}>Booking pages</h3><button className={primary} disabled={!types.length} onClick={() => setEdit({ slug: "", title: "Book an appointment", intro: "", typeIds: types.map((t) => t.id), active: true, enquiryEnabled: true, showStaffChoice: false, brandColor: "#0b6e75", privacyNote: "" })}>New page</button></div>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {!types.length && <p className={muted}>Create an appointment type first.</p>}
      <div className="space-y-2">{(data?.pages || []).map((p) => (
        <div key={p.id} className={row}>
          <div className="min-w-0"><p className="text-sm text-[var(--inaya-text-primary)]">{p.title} {!p.active && <span className="text-amber-300 text-xs">(not published)</span>}</p><a className="text-xs underline text-[#00f2fe] break-all" href={p.url} target="_blank" rel="noreferrer">{p.url}</a><p className={muted}>{p.stats.views} visits · {p.stats.completions} bookings · {p.stats.enquiries} enquiries</p></div>
          <div className="flex gap-2"><button className={ghost} onClick={() => navigator.clipboard?.writeText(p.url)}>Copy link</button><button className={ghost} onClick={() => setEdit({ ...p })}>Edit</button></div>
        </div>
      ))}</div>
    </div>
  );
}

function SettingsSetup({ orgId, options }) {
  const [data, reload] = useLoad(() => api(`/api/orgs/appointments/settings?orgId=${orgId}`), [orgId]);
  const [seqs] = useLoad(() => api(`/api/orgs/campaigns/sequences?orgId=${orgId}`).catch(() => ({ sequences: [] })), [orgId]);
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { if (data?.settings) setS({ ...data.settings, reminderText: (data.settings.reminderOffsetsMinutes || []).map((m) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join(", ") }); }, [data]);
  if (!s) return <p className={muted}>Loading…</p>;
  const parseOffsets = (t) => t.split(/[,\s]+/).filter(Boolean).map((x) => { const m = /^(\d+)\s*(h|m|d)?$/i.exec(x); if (!m) return NaN; const n = Number(m[1]); return (m[2] || "h").toLowerCase() === "d" ? n * 1440 : (m[2] || "h").toLowerCase() === "h" ? n * 60 : n; });
  const save = async () => { setMsg(""); try { await api(`/api/orgs/appointments/settings`, { method: "PUT", body: JSON.stringify({ orgId, businessName: s.businessName, replyToEmail: s.replyToEmail, reminderOffsetsMinutes: parseOffsets(s.reminderText), smsReminders: s.smsReminders, notifyStaffByEmail: s.notifyStaffByEmail, enquiryWelcome: s.enquiryWelcome, enquiryWelcomeMessage: s.enquiryWelcomeMessage, postMeetingPromptMinutes: Number(s.postMeetingPromptMinutes), followUpSequenceId: s.followUpSequenceId || null }) }); setMsg("Saved."); reload(); } catch (e) { setMsg(e.message); } };
  return (
    <div className={panel}>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1"><span className={muted}>Business name in emails</span><input className={`${input} w-full`} value={s.businessName} onChange={(e) => setS({ ...s, businessName: e.target.value })} /></label>
        <label className="space-y-1"><span className={muted}>Replies go to (optional)</span><input className={`${input} w-full`} value={s.replyToEmail} onChange={(e) => setS({ ...s, replyToEmail: e.target.value })} /></label>
        <label className="space-y-1"><span className={muted}>Reminders before (e.g. 24h, 1h)</span><input className={`${input} w-full`} value={s.reminderText} onChange={(e) => setS({ ...s, reminderText: e.target.value })} /></label>
        <label className="space-y-1"><span className={muted}>Ask staff for notes this long after a meeting (minutes, 0 = off)</span><input type="number" className={`${input} w-full`} value={s.postMeetingPromptMinutes} onChange={(e) => setS({ ...s, postMeetingPromptMinutes: e.target.value })} /></label>
        <label className="space-y-1 sm:col-span-2"><span className={muted}>Welcome email for enquiries</span><textarea className={`${input} w-full`} rows={2} placeholder="We've received your enquiry and someone from our team will reply soon." value={s.enquiryWelcomeMessage} onChange={(e) => setS({ ...s, enquiryWelcomeMessage: e.target.value })} /></label>
        <label className="space-y-1 sm:col-span-2"><span className={muted}>Follow-up sequence after a completed meeting</span><select className={`${input} w-full`} value={s.followUpSequenceId || ""} onChange={(e) => setS({ ...s, followUpSequenceId: e.target.value })}><option value="">None</option>{(seqs?.sequences || []).map((q) => <option key={q.id} value={q.id}>{q.name} ({label(q.status)})</option>)}</select></label>
      </div>
      <div className="flex flex-wrap gap-4 mt-3 text-sm text-[var(--inaya-text-primary)]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={s.smsReminders} onChange={(e) => setS({ ...s, smsReminders: e.target.checked })} /> SMS reminders too</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={s.notifyStaffByEmail} onChange={(e) => setS({ ...s, notifyStaffByEmail: e.target.checked })} /> Email staff about new bookings</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={s.enquiryWelcome} onChange={(e) => setS({ ...s, enquiryWelcome: e.target.checked })} /> Send the enquiry welcome email</label>
      </div>
      {s.smsReminders && options && !options.smsAvailable && <p className="text-amber-300 text-xs mt-2">SMS isn&apos;t connected yet (Twilio). Email reminders still go out; SMS starts once it&apos;s connected.</p>}
      <button className={`${primary} mt-4`} onClick={save}>Save settings</button>
      {msg && <p className="text-sm text-[var(--inaya-text-primary)] mt-2">{msg}</p>}
    </div>
  );
}

function RolesSetup({ orgId, options }) {
  const [members, setMembers] = useState(options?.members || []);
  const [msg, setMsg] = useState("");
  const set = async (email, calendarRole) => { setMsg(""); try { await api(`/api/orgs/appointments/roles`, { method: "PUT", body: JSON.stringify({ orgId, email, calendarRole: calendarRole || null }) }); setMembers((m) => m.map((x) => (x.email === email ? { ...x, calendarRole: calendarRole || null } : x))); } catch (e) { setMsg(e.message); } };
  return (
    <div className={panel}>
      <h3 className={h3}>Calendar roles</h3>
      <p className={`${muted} mb-3`}>Everyone keeps their own calendar. Calendar managers also see the whole team, manage appointment types, booking pages and enquiries. Owners and admins are always managers.</p>
      {members.map((m) => <div key={m.email} className={`${row} mb-1`}><span className="text-sm text-[var(--inaya-text-primary)]">{m.email}</span><select className={input} value={m.calendarRole || ""} onChange={(e) => set(m.email, e.target.value)}><option value="">Own calendar</option><option value="manager">Calendar manager</option></select></div>)}
      {msg && <p className="text-red-300 text-sm">{msg}</p>}
    </div>
  );
}
