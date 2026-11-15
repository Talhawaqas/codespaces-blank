"use client";

// src/components/business/HospitalityView.js
//
// Hospitality OS tab of the Business Workspace (restaurants, cafes, caterers, cloud kitchens). Same
// self-contained-view pattern as EducationView.js: nothing from business/page.js beyond {orgId, canManage, email};
// sections register with useErpSection so they appear in the ERP task panel. CRM, Inventory, Procurement, HR,
// Finance, Campaigns and Automations are linked, not copied: they stay the authoritative screens.

import { useState, useEffect, useMemo } from "react";
import { useErpSection } from "./erp/ErpNavContext";
import { api, H, send, panel, row, input, primary, ghost, danger, muted, h3, label, today, addDays, STATUS_TONE, useLoad, useAction, Msg, Field, State, Stat, Confirm } from "./hospitality/shared";
import { MenuTab, StockTab, OperationsTab } from "./hospitality/Back";
import { CampaignsTab, ReportsTab, SettingsTab } from "./hospitality/Admin";

const TABS = [["overview", "Overview"], ["reservations", "Reservations"], ["floor", "Floor & tables"], ["waitlist", "Waitlist"], ["guests", "Guests"], ["menu", "Menu & recipes"], ["stock", "Stock"], ["operations", "Operations"], ["campaigns", "Campaigns"], ["reports", "Reports"], ["settings", "Settings"]];

export default function HospitalityView({ orgId, canManage, email }) {
  const [tab, setTab] = useErpSection("overview", TABS);
  const [overview, reloadOverview, overviewError, loading] = useLoad(() => api(H(orgId, "overview")), [orgId]);
  const [options] = useLoad(() => api(H(orgId, "options")), [orgId]);
  const locations = overview?.locations || [];
  const [locationId, setLocationId] = useState("");
  useEffect(() => {
    if (!locations.length) return;
    let saved = ""; try { saved = window.localStorage.getItem(`inaya-hosp-loc-${orgId}`) || ""; } catch { saved = ""; }
    if (!locationId || !locations.some((l) => l.id === locationId)) setLocationId(locations.some((l) => l.id === saved) ? saved : locations[0].id);
  }, [locations, locationId, orgId]);
  const pick = (id) => { setLocationId(id); try { window.localStorage.setItem(`inaya-hosp-loc-${orgId}`, id); } catch { /* storage unavailable */ } };
  const location = locations.find((l) => l.id === locationId) || null;
  const can = overview?.can || {};
  const ctx = { orgId, email, canManage, can, options, location, locationId, locations, reloadOverview, go: setTab };
  const visible = TABS.filter(([k]) => ({ reservations: can.reservationsRead, floor: can.reservationsRead, waitlist: can.reservationsRead, guests: can.guestNotes, stock: can.stockRead, campaigns: can.manage, reports: can.reports }[k] ?? true));
  const needsLocation = !["overview", "settings", "campaigns", "menu"].includes(tab);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap" data-erp-tabs>
          {visible.map(([key, text]) => (
            <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? "page" : undefined} className={`px-3 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{text}</button>
          ))}
        </div>
        {locations.length > 0 && (
          <label className="flex items-center gap-2 text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Location
            <select className={input} value={locationId} onChange={(e) => pick(e.target.value)} aria-label="Location">
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <State loading={loading} error={overviewError}>
        {!locations.length && tab !== "settings" ? (
          <div className={panel}>
            <h3 className={h3}>Set up your first location</h3>
            <p className={muted}>{can.manage ? "Add your restaurant, its opening hours and its tables. Reservations, the floor view, stock and the roster all work per location." : "A manager needs to add a location before the workspace can be used."}</p>
            {can.manage && <button className={`${primary} mt-3`} onClick={() => setTab("settings")}>Add a location</button>}
          </div>
        ) : needsLocation && !location ? <p className={muted}>Choose a location.</p> : (
          <>
            {tab === "overview" && <OverviewTab {...ctx} overview={overview} />}
            {tab === "reservations" && <ReservationsTab {...ctx} />}
            {tab === "floor" && <FloorTab {...ctx} />}
            {tab === "waitlist" && <WaitlistTab {...ctx} />}
            {tab === "guests" && <GuestsTab {...ctx} />}
            {tab === "menu" && <MenuTab {...ctx} />}
            {tab === "stock" && <StockTab {...ctx} />}
            {tab === "operations" && <OperationsTab {...ctx} />}
            {tab === "campaigns" && <CampaignsTab {...ctx} />}
            {tab === "reports" && <ReportsTab {...ctx} />}
            {tab === "settings" && <SettingsTab {...ctx} />}
          </>
        )}
      </State>
    </div>
  );
}

// ---------------- Overview ----------------
function OverviewTab({ overview, go, can, reloadOverview }) {
  // Counts change as people work in the other tabs: refresh whenever the overview is opened.
  useEffect(() => { reloadOverview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const c = overview?.cards;
  if (!c) return null;
  const r = c.reservations, s = c.stock, o = c.operations;
  return (
    <div className="space-y-4">
      {r && (
        <div className={panel}>
          <h3 className={h3}>Today</h3>
          <div className="flex gap-3 flex-wrap">
            <Stat label="Reservations" value={r.today} /><Stat label="Expected guests" value={r.expectedCovers} /><Stat label="Seated now" value={r.seated} tone="text-emerald-400" />
            <Stat label="Completed" value={r.completed} /><Stat label="On the waitlist" value={r.waitlist} /><Stat label="Private events ahead" value={r.upcomingPrivateEvents} />
          </div>
          <div className="mt-3 space-y-2">
            {r.pendingConfirmation > 0 && <button className={`${row} w-full text-left`} onClick={() => go("reservations")}><span className="text-sm text-amber-400">{r.pendingConfirmation} reservation{r.pendingConfirmation > 1 ? "s" : ""} waiting for confirmation</span><span className={ghost}>Review</span></button>}
            {r.unassigned > 0 && <button className={`${row} w-full text-left`} onClick={() => go("floor")}><span className="text-sm text-amber-400">{r.unassigned} reservation{r.unassigned > 1 ? "s" : ""} without a table</span><span className={ghost}>Assign</span></button>}
            {r.duplicateReviews > 0 && <button className={`${row} w-full text-left`} onClick={() => go("guests")}><span className="text-sm">{r.duplicateReviews} guest{r.duplicateReviews > 1 ? "s" : ""} may already be in your CRM</span><span className={ghost}>Review</span></button>}
          </div>
        </div>
      )}
      {s && (
        <div className={panel}>
          <h3 className={h3}>Stock</h3>
          {s.status === "not_linked" ? <p className={muted}>{s.message}</p> : (
            <div className="flex gap-3 flex-wrap">
              <Stat label="Low-stock items" value={s.lowStock} tone={s.lowStock ? "text-amber-400" : ""} /><Stat label="Purchase requests in progress" value={s.pendingPurchaseRequests} />
              <Stat label="Wastage to approve" value={s.wastageAwaitingApproval} tone={s.wastageAwaitingApproval ? "text-amber-400" : ""} /><Stat label="Open delivery issues" value={s.openDeliveryIssues} tone={s.openDeliveryIssues ? "text-amber-400" : ""} />
            </div>
          )}
        </div>
      )}
      <div className={panel}>
        <h3 className={h3}>Operations</h3>
        <div className="flex gap-3 flex-wrap">
          <Stat label="Checklists done today" value={`${o.checklistsCompleted}/${o.checklistsToday}`} /><Stat label="Checklist items overdue" value={o.checklistItemsOverdue} tone={o.checklistItemsOverdue ? "text-red-400" : ""} />
          {o.openIncidents !== null && <Stat label="Open incidents" value={o.openIncidents} tone={o.openIncidents ? "text-amber-400" : ""} />}
        </div>
        <p className={`${muted} mt-3`}>{c.myNextShift ? `Your next shift: ${c.myNextShift.date}, ${c.myNextShift.startTime} to ${c.myNextShift.endTime} (${label(c.myNextShift.role)}).` : "You have no upcoming published shift."}</p>
      </div>
      {can.manage && <p className={muted}>Figures are counted from today&apos;s records for the locations you can see. Sales and food cost aren&apos;t shown: no point-of-sale system is connected.</p>}
    </div>
  );
}

// ---------------- Reservations ----------------
function ReservationsTab({ orgId, location, locationId, can, options }) {
  const [view, setView] = useState("day");
  const [date, setDate] = useState(today());
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const from = view === "month" ? `${date.slice(0, 7)}-01` : date;
  const to = view === "day" ? date : view === "week" ? addDays(date, 6) : addDays(`${date.slice(0, 7)}-01`, 30);
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "reservations", { locationId, from, to, status, q, limit: 500 })), [orgId, locationId, from, to, status, q]);
  const rows = data?.reservations || [];
  const byDate = useMemo(() => { const m = new Map(); for (const r of rows) { if (!m.has(r.date)) m.set(r.date, []); m.get(r.date).push(r); } return [...m.entries()].sort(); }, [rows]);
  const step = view === "day" ? 1 : view === "week" ? 7 : 30;
  return (
    <div className="space-y-4">
      <div className={`${panel} flex gap-3 flex-wrap items-end`}>
        <div className="flex border border-white/10 rounded-lg overflow-hidden" role="group" aria-label="Calendar view">
          {["day", "week", "month"].map((v) => <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`px-3 py-2 text-xs font-bold uppercase ${view === v ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{v}</button>)}
        </div>
        <button className={ghost} onClick={() => setDate(addDays(date, -step))} aria-label="Earlier">‹</button>
        <Field label="Date"><input type="date" className={input} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        <button className={ghost} onClick={() => setDate(addDays(date, step))} aria-label="Later">›</button>
        <button className={ghost} onClick={() => setDate(today())}>Today</button>
        <Field label="Status"><select className={input} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{(options?.statuses || []).map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Search"><input className={input} placeholder="Guest name or reference" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        {can.reservationsWrite && <button className={primary} onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "New reservation"}</button>}
      </div>
      <p className={muted}>Times are shown in {location.timeZone}.</p>
      {adding && <ReservationForm orgId={orgId} location={location} options={options} onDone={() => { setAdding(false); reload(); }} />}
      <State loading={loading} error={error} empty={!rows.length} emptyText="No reservations in this range.">
        {byDate.map(([d, list]) => (
          <div key={d} className={panel}>
            <h3 className={h3}>{new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · {list.filter((r) => !["CANCELLED", "DECLINED", "NO_SHOW"].includes(r.status)).reduce((n, r) => n + r.partySize, 0)} guests</h3>
            <div className="space-y-2">
              {(view === "month" ? list.slice(0, 6) : list).map((r) => (
                <button key={r.id} className={`${row} w-full text-left`} onClick={() => setOpen(r.id)}>
                  <span className="text-sm text-[var(--inaya-text-primary)]"><strong>{r.time}</strong> · {r.guest.name} · party of {r.partySize}{r.type !== "table" ? ` · ${label(r.type)}` : ""}</span>
                  <span className={muted}>{r.tableLabels?.length ? `Table ${r.tableLabels.join(" + ")}` : "No table"} · <span className={STATUS_TONE[r.status]}>{label(r.status)}</span> · {r.ref}</span>
                </button>
              ))}
              {view === "month" && list.length > 6 && <button className={ghost} onClick={() => { setDate(d); setView("day"); }}>Show all {list.length}</button>}
            </div>
          </div>
        ))}
      </State>
      {open && <ReservationDetail orgId={orgId} id={open} can={can} options={options} location={location} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function ReservationForm({ orgId, location, options, onDone }) {
  const [f, setF] = useState({ name: "", email: "", phone: "", partySize: 2, date: today(), time: "", type: "table", source: "phone", occasion: "", guestNote: "", internalNote: "", marketingConsent: false, tableIds: [] });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const { busy, msg, run } = useAction();
  const [avail] = useLoad(() => (f.source === "walk_in" ? Promise.resolve(null) : api(H(orgId, `locations/${location.id}/availability`, { date: f.date, partySize: f.partySize || 1 }))), [orgId, location.id, f.date, f.partySize, f.source]);
  const [seating] = useLoad(() => api(H(orgId, `locations/${location.id}/seating`)), [orgId, location.id]);
  const [key] = useState(() => `ui:${Date.now()}:${Math.random().toString(36).slice(2)}`);
  const save = (override) => run(() => send(orgId, "reservations", "POST", { ...f, locationId: location.id, partySize: Number(f.partySize), idempotencyKey: key, override, wantAlternatives: true }), (r) => (r.unassigned ? "Saved. No table was free to assign automatically: assign one from the Floor view." : "Reservation saved.")).then((r) => r && onDone());
  return (
    <form className={`${panel} space-y-3`} onSubmit={(e) => { e.preventDefault(); save(false); }}>
      <h3 className={h3}>New reservation</h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Guest name"><input className={input} required value={f.name} onChange={set("name")} /></Field>
        <Field label="Email" hint="Needed for the confirmation email"><input className={input} type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><input className={input} value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Guests"><input className={input} type="number" min="1" max="500" required value={f.partySize} onChange={set("partySize")} /></Field>
        <Field label="How it came in"><select className={input} value={f.source} onChange={set("source")}>{["phone", "staff", "walk_in"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Type"><select className={input} value={f.type} onChange={set("type")}>{(options?.types || ["table"]).map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        {f.source !== "walk_in" && <Field label="Date"><input className={input} type="date" required value={f.date} onChange={set("date")} /></Field>}
        {f.source !== "walk_in" && (
          <Field label="Time" hint={avail ? `${avail.slots.filter((s) => s.available).length} free times that day` : ""}>
            <input className={input} type="time" step="900" required list="hosp-slots" value={f.time} onChange={set("time")} />
            <datalist id="hosp-slots">{(avail?.slots || []).filter((s) => s.available).map((s) => <option key={s.time} value={s.time} />)}</datalist>
          </Field>
        )}
        <Field label="Table" hint="Leave on automatic to let the system choose">
          <select className={input} value={f.tableIds[0] || ""} onChange={(e) => setF((x) => ({ ...x, tableIds: e.target.value ? [e.target.value] : [] }))}>
            <option value="">Automatic</option>{(seating?.tables || []).filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.label} (seats {t.minParty} to {t.maxParty})</option>)}
          </select>
        </Field>
        <Field label="Occasion"><input className={input} value={f.occasion} onChange={set("occasion")} placeholder="Birthday, business dinner" /></Field>
        <Field label="Guest request" className="lg:col-span-2"><input className={input} value={f.guestNote} onChange={set("guestNote")} placeholder="What the guest asked for" /></Field>
        <Field label="Staff note (not shown to service staff)" className="lg:col-span-2"><input className={input} value={f.internalNote} onChange={set("internalNote")} /></Field>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={f.marketingConsent} onChange={set("marketingConsent")} /> The guest agreed to receive marketing emails (separate from this booking)</label>
      <Msg msg={msg} />
      <div className="flex gap-2 flex-wrap">
        <button className={primary} disabled={busy}>{busy ? "Saving…" : "Save reservation"}</button>
        {msg && !msg.ok && /fully booked/i.test(msg.text) && <Confirm text="Book this anyway, above the capacity you set for this time?" onYes={() => save(true)} className={ghost}>Book anyway</Confirm>}
      </div>
    </form>
  );
}

function ReservationDetail({ orgId, id, can, options, location, onClose, onChanged }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, `reservations/${id}`)), [orgId, id]);
  const [seating] = useLoad(() => api(H(orgId, `locations/${location.id}/seating`)), [orgId, location.id]);
  const { busy, msg, run } = useAction();
  const [edit, setEdit] = useState(null);
  const r = data?.reservation;
  const after = () => { reload(); onChanged(); };
  const move = (toStatus, extra = {}) => run(() => send(orgId, `reservations/${id}/transition`, "POST", { toStatus, ...extra }), `Marked ${label(toStatus).toLowerCase()}.`).then((x) => x && after());
  const floorMoves = ["ARRIVED", "SEATED", "COMPLETED"];
  const next = (options?.transitions?.[r?.status] || []).filter((s) => (floorMoves.includes(s) ? can.serviceUpdate : can.reservationsWrite));
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex justify-end" role="dialog" aria-modal="true" aria-label="Reservation" onClick={onClose}>
      <div className="w-full max-w-lg h-full overflow-y-auto bg-[var(--inaya-surface)] border-l border-white/10 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center"><h3 className="text-[var(--inaya-text-primary)] font-semibold">Reservation {r?.ref || ""}</h3><button className={ghost} onClick={onClose}>Close</button></div>
        <State loading={loading} error={error}>
          {r && (
            <>
              <div className="space-y-1 text-sm text-[var(--inaya-text-primary)]">
                <p><strong>{r.guest.name}</strong> · party of {r.partySize} · <span className={STATUS_TONE[r.status]}>{label(r.status)}</span></p>
                <p>{r.date} at {r.time} ({r.timeZone}), {r.durationMinutes} minutes</p>
                <p className={muted}>Table: {r.tableLabels?.length ? r.tableLabels.join(" + ") : "not assigned"} · Came in by {label(r.source).toLowerCase()}</p>
                {r.guest.email !== undefined && <p className={muted}>{r.guest.email || "No email"} · {r.guest.phone || "No phone"}</p>}
                {r.occasion && <p className={muted}>Occasion: {r.occasion}</p>}
                {r.guestNote && <p className={muted}>Guest request: {r.guestNote}</p>}
                {r.preferences && <p className={muted}>Seating preference: {r.preferences}</p>}
                {r.internalNote && <p className="text-amber-400 text-[12px]">Staff note: {r.internalNote}</p>}
                {r.cancelReason && <p className={muted}>Reason: {r.cancelReason}</p>}
                {r.confirmation && Object.entries(r.confirmation).map(([k, v]) => <p key={k} className={muted}>{label(k)} email: {v.status === "accepted_by_provider" ? "handed to the mail provider (delivery not confirmed)" : `failed${v.error ? `: ${v.error}` : ""}`}</p>)}
                {r.feedback && <p className={muted}>Feedback: {r.feedback.rating}/5{r.feedback.comment ? `, ${r.feedback.comment}` : ""}</p>}
              </div>
              <Msg msg={msg} />
              <div className="flex gap-2 flex-wrap">
                {next.map((s) => ["CANCELLED", "DECLINED", "NO_SHOW"].includes(s)
                  ? <button key={s} className={danger} disabled={busy} onClick={() => { const reason = s === "NO_SHOW" ? "" : window.prompt(`Reason for ${label(s).toLowerCase()} (sent to the guest):`); if (reason !== null) move(s, { reason }); }}>{label(s)}</button>
                  : <button key={s} className={primary} disabled={busy} onClick={() => move(s)}>{s === "CONFIRMED" ? "Confirm" : `Mark ${label(s).toLowerCase()}`}</button>)}
                {can.reservationsWrite && ["REQUESTED", "PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED", "SEATED"].includes(r.status) && <button className={ghost} onClick={() => setEdit(edit ? null : { date: r.date, time: r.time, partySize: r.partySize, tableIds: r.tableIds, internalNote: r.internalNote || "" })}>{edit ? "Cancel change" : "Change"}</button>}
              </div>
              {edit && (
                <form className="space-y-3 border-t border-white/10 pt-3" onSubmit={(e) => { e.preventDefault(); run(() => send(orgId, `reservations/${id}`, "PATCH", { ...edit, partySize: Number(edit.partySize) }), "Reservation changed.").then((x) => { if (x) { setEdit(null); after(); } }); }}>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Date"><input className={input} type="date" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
                    <Field label="Time"><input className={input} type="time" step="900" value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} /></Field>
                    <Field label="Guests"><input className={input} type="number" min="1" value={edit.partySize} onChange={(e) => setEdit({ ...edit, partySize: e.target.value })} /></Field>
                    <Field label="Tables" hint="Hold Ctrl to pick tables that can be combined">
                      <select multiple className={`${input} h-24`} value={edit.tableIds} onChange={(e) => setEdit({ ...edit, tableIds: [...e.target.selectedOptions].map((o) => o.value) })}>{(seating?.tables || []).map((t) => <option key={t.id} value={t.id}>{t.label} ({t.minParty} to {t.maxParty})</option>)}</select>
                    </Field>
                    {r.internalNote !== undefined && <Field label="Staff note" className="col-span-2"><input className={input} value={edit.internalNote} onChange={(e) => setEdit({ ...edit, internalNote: e.target.value })} /></Field>}
                  </div>
                  <button className={primary} disabled={busy}>Save change</button>
                </form>
              )}
              {r.status === "COMPLETED" && !r.feedback && can.serviceUpdate && (
                <form className="flex gap-2 items-end flex-wrap border-t border-white/10 pt-3" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, `reservations/${id}/feedback`, "POST", { rating: Number(fd.get("rating")), comment: fd.get("comment") }), "Feedback recorded.").then((x) => x && after()); }}>
                  <Field label="Guest feedback (1 to 5)"><input name="rating" className={input} type="number" min="1" max="5" required /></Field>
                  <Field label="Comment"><input name="comment" className={input} /></Field>
                  <button className={ghost} disabled={busy}>Record</button>
                </form>
              )}
              {r.history && <details><summary className={`${muted} cursor-pointer`}>History</summary><ul className="mt-2 space-y-1">{r.history.map((h, i) => <li key={i} className={muted}>{new Date(h.at).toLocaleString()} · {h.by} · {h.to ? label(h.to) : label(h.change)}{h.note ? ` (${h.note})` : ""}</li>)}</ul></details>}
            </>
          )}
        </State>
      </div>
    </div>
  );
}

// ---------------- Floor & tables ----------------
const TABLE_TONE = { free: "border-emerald-400/30 text-emerald-400", reserved: "border-[#00f2fe]/40 text-[#00f2fe]", seated: "border-amber-400/40 text-amber-400", closed: "border-white/10 text-[var(--inaya-text-muted)]" };
function FloorTab({ orgId, location, locationId, can, options }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, `locations/${locationId}/floor`)), [orgId, locationId]);
  const [open, setOpen] = useState(null);
  const { busy, msg, run } = useAction();
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  const assign = (resId, tableId) => run(() => send(orgId, `reservations/${resId}`, "PATCH", { tableIds: [tableId] }), "Table assigned.").then((x) => x && reload());
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2"><p className={muted}>{location.name} · {data ? new Date(data.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: data.timeZone }) : ""} ({location.timeZone}) · refreshes every minute</p><button className={ghost} onClick={reload}>Refresh</button></div>
      <Msg msg={msg} />
      <State loading={loading} error={error} empty={data && !data.tables.length} emptyText="No tables yet. A manager can add seating areas and tables in Settings.">
        {(data?.areas || []).map((a) => (
          <div key={a.id} className={panel}>
            <h3 className={h3}>{a.name}{a.closed ? " (closed)" : ""}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {data.tables.filter((t) => t.areaId === a.id).map((t) => (
                <button key={t.id} disabled={!t.current} onClick={() => t.current && setOpen(t.current.id)} className={`text-left border rounded-xl p-3 bg-black/20 ${TABLE_TONE[t.state]}`} aria-label={`Table ${t.label}, ${t.state}`}>
                  <p className="font-semibold">Table {t.label}</p>
                  <p className="text-[11px]">Seats {t.minParty} to {t.maxParty} · {label(t.state)}</p>
                  {t.current && <p className="text-[11px] text-[var(--inaya-text-primary)]">{t.current.guestName} ({t.current.partySize}), {t.current.time}</p>}
                  {t.next && <p className="text-[11px] text-[var(--inaya-text-muted)]">Next: {t.next.time} ({t.next.partySize})</p>}
                </button>
              ))}
            </div>
          </div>
        ))}
        {data?.unassigned?.length > 0 && (
          <div className={panel}>
            <h3 className={h3}>Reservations without a table</h3>
            <div className="space-y-2">{data.unassigned.map((r) => (
              <div key={r.id} className={row}>
                <button className="text-sm text-[var(--inaya-text-primary)] text-left" onClick={() => setOpen(r.id)}>{r.time} · {r.guestName} · party of {r.partySize}</button>
                {can.reservationsWrite && <select className={input} disabled={busy} defaultValue="" aria-label="Assign a table" onChange={(e) => e.target.value && assign(r.id, e.target.value)}><option value="">Assign a table…</option>{data.tables.filter((t) => t.state !== "closed" && t.maxParty >= r.partySize).map((t) => <option key={t.id} value={t.id}>{t.label} (seats {t.maxParty})</option>)}</select>}
              </div>
            ))}</div>
          </div>
        )}
      </State>
      {open && <ReservationDetail orgId={orgId} id={open} can={can} options={options} location={location} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

// ---------------- Waitlist ----------------
function WaitlistTab({ orgId, locationId, can }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "waitlist", { locationId })), [orgId, locationId]);
  const [next, reloadNext] = useLoad(() => api(H(orgId, "waitlist/next", { locationId })), [orgId, locationId]);
  const { busy, msg, run } = useAction();
  const act = (id, action, okText, extra = {}) => run(() => send(orgId, `waitlist/${id}`, "POST", { action, ...extra }), okText).then(() => { reload(); reloadNext(); });
  return (
    <div className="space-y-4">
      {can.reservationsWrite && (
        <form className={`${panel} flex gap-3 flex-wrap items-end`} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, "waitlist", "POST", { locationId, name: fd.get("name"), phone: fd.get("phone"), email: fd.get("email"), partySize: Number(fd.get("partySize")), quotedMinutes: fd.get("quoted") || null, note: fd.get("note") }), "Added to the waitlist.").then((x) => { if (x) { e.target.reset(); reload(); reloadNext(); } }); }}>
          <Field label="Guest name"><input name="name" className={input} required /></Field>
          <Field label="Guests"><input name="partySize" className={`${input} w-20`} type="number" min="1" required defaultValue="2" /></Field>
          <Field label="Phone"><input name="phone" className={input} /></Field>
          <Field label="Email"><input name="email" type="email" className={input} /></Field>
          <Field label="Wait you quoted (minutes)" hint="Optional. The system doesn't estimate waits."><input name="quoted" className={`${input} w-28`} type="number" min="0" /></Field>
          <Field label="Note"><input name="note" className={input} /></Field>
          <button className={primary} disabled={busy}>Add</button>
        </form>
      )}
      <Msg msg={msg} />
      {next?.suggestion && <div className={`${panel} border-emerald-400/30`}><p className="text-sm text-emerald-400">A table is free now for {next.suggestion.entry.guest.name} (party of {next.suggestion.entry.partySize}): table {next.suggestion.tables.map((t) => t.label).join(" + ")}.</p></div>}
      <div className={panel}>
        <h3 className={h3}>Waiting</h3>
        <State loading={loading} error={error} empty={!data?.waitlist?.length} emptyText="Nobody is waiting.">
          <div className="space-y-2">{(data?.waitlist || []).map((w) => (
            <div key={w.id} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{w.guest.name} · party of {w.partySize} · waiting since {new Date(w.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{w.quotedMinutes !== null ? ` · quoted ${w.quotedMinutes} min` : ""}{w.status === "INVITED" ? " · invited" : ""}{w.note ? ` · ${w.note}` : ""}</span>
              {can.reservationsWrite && <span className="flex gap-2">
                <button className={ghost} disabled={busy} onClick={() => act(w.id, "invite", (r) => (r?.emailed ? "Marked as invited and emailed." : "Marked as invited. No email was sent (no address, or the send failed): tell the guest in person."))}>Invite</button>
                <button className={primary} disabled={busy} onClick={() => act(w.id, "seat", "Seated.")}>Seat now</button>
                <Confirm text="Remove this party from the waitlist?" className={danger} disabled={busy} onYes={() => act(w.id, "cancel", "Removed.")}>Remove</Confirm>
              </span>}
            </div>
          ))}</div>
        </State>
      </div>
    </div>
  );
}

// ---------------- Guests ----------------
function GuestsTab({ orgId, can }) {
  const [dupes, reloadDupes] = useLoad(() => (can.manage ? api(H(orgId, "guests/duplicates")) : Promise.resolve({ reviews: [] })), [orgId, can.manage]);
  const [q, setQ] = useState("");
  const [contacts, , error, loading] = useLoad(() => api(H(orgId, "guests", { q })), [orgId, q]);
  const [open, setOpen] = useState(null);
  const { busy, msg, run } = useAction();
  const list = contacts?.guests || [];
  return (
    <div className="space-y-4">
      <p className={muted}>Guests are your CRM contacts. Reservations link to them; names, tags and deals are edited in <a className="underline" href="/business?view=crm">CRM</a>.</p>
      <Msg msg={msg} />
      {dupes?.reviews?.length > 0 && (
        <div className={panel}>
          <h3 className={h3}>Possible matches to review</h3>
          <p className={`${muted} mb-3`}>These bookings share a phone number with someone already in your CRM. Nothing is merged automatically.</p>
          <div className="space-y-2">{dupes.reviews.map((d) => (
            <div key={d.reservationId} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{d.ref}: {d.guest.name} ({d.guest.phone})</span>
              <span className="flex gap-2 flex-wrap">{d.candidates.map((c) => <button key={c.contactId} className={ghost} disabled={busy} onClick={() => run(() => send(orgId, `guests/duplicates/${d.reservationId}`, "POST", { contactId: c.contactId }), "Linked.").then(reloadDupes)}>Same as {c.name}</button>)}<button className={ghost} disabled={busy} onClick={() => run(() => send(orgId, `guests/duplicates/${d.reservationId}`, "POST", { contactId: null }), "Kept separate.").then(reloadDupes)}>Not the same person</button></span>
            </div>
          ))}</div>
        </div>
      )}
      <div className={panel}>
        <div className="flex justify-between items-center gap-3 flex-wrap mb-3"><h3 className="text-[var(--inaya-text-primary)] font-semibold text-sm">Guest directory</h3><input className={input} placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search guests" /></div>
        <State loading={loading} error={error} empty={!list.length} emptyText="No guests yet. They appear here as reservations come in.">
          <div className="space-y-2">{list.map((c) => <button key={c.contactId} className={`${row} w-full text-left`} onClick={() => setOpen(c.contactId)}><span className="text-sm text-[var(--inaya-text-primary)]">{c.name}</span><span className={muted}>{c.visits} visit{c.visits === 1 ? "" : "s"} · {c.email || c.phone || ""}</span></button>)}</div>
        </State>
      </div>
      {open && <GuestProfile orgId={orgId} contactId={open} can={can} onClose={() => setOpen(null)} />}
    </div>
  );
}

function GuestProfile({ orgId, contactId, can, onClose }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, `guests/${contactId}`)), [orgId, contactId]);
  const { busy, msg, run } = useAction();
  const g = data?.guest, s = data?.summary;
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex justify-end" role="dialog" aria-modal="true" aria-label="Guest profile" onClick={onClose}>
      <div className="w-full max-w-lg h-full overflow-y-auto bg-[var(--inaya-surface)] border-l border-white/10 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center"><h3 className="text-[var(--inaya-text-primary)] font-semibold">{g?.name || "Guest"}</h3><button className={ghost} onClick={onClose}>Close</button></div>
        <State loading={loading} error={error}>
          {g && (
            <>
              <p className={muted}>{g.email || "No email"} · {g.phone || "No phone"} · <a className="underline" href="/business?view=crm">Open in CRM</a></p>
              <div className="flex gap-3 flex-wrap"><Stat label="Visits" value={s.visits} /><Stat label="Reservations" value={s.reservations} /><Stat label="No-shows" value={s.noShows} /><Stat label="Cancelled" value={s.cancellations} /></div>
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, `guests/${contactId}`, "PATCH", { preferences: fd.get("preferences"), preferredChannel: fd.get("channel") }), "Saved.").then((x) => x && reload()); }}>
                <Field label="Preferences the guest told you" hint="Only what they chose to share and you need for service."><textarea name="preferences" className={`${input} h-20`} defaultValue={g.preferences || ""} /></Field>
                <Field label="Preferred way to be contacted"><select name="channel" className={input} defaultValue={g.preferredChannel || ""}><option value="">Not set</option><option value="email">Email</option><option value="phone">Phone</option><option value="sms">Text</option></select></Field>
                <button className={ghost} disabled={busy}>Save</button>
              </form>
              <Msg msg={msg} />
              <div><h4 className={h3}>History</h4><div className="space-y-1">{data.reservations.length ? data.reservations.map((r) => <p key={r.id} className={muted}>{r.date} {r.time} · party of {r.partySize} · <span className={STATUS_TONE[r.status]}>{label(r.status)}</span>{r.feedback ? ` · ${r.feedback.rating}/5` : ""}</p>) : <p className={muted}>No reservations yet.</p>}</div></div>
              {can.guestExport && (
                <div className="border-t border-white/10 pt-3 flex gap-2 flex-wrap">
                  <button className={ghost} disabled={busy} onClick={() => run(async () => { const d = await api(H(orgId, `guests/${contactId}/export`)); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })); a.download = `guest-${contactId}.json`; a.click(); URL.revokeObjectURL(a.href); }, "Export downloaded. This export is recorded in the audit log.")}>Export this guest&apos;s data</button>
                  <button className={danger} disabled={busy} onClick={() => { const reason = window.prompt("Erase this guest's details from all their reservations? This can't be undone. Give a reason for the record:"); if (reason) run(() => send(orgId, `guests/${contactId}/erase`, "POST", { confirm: "ERASE", reason }), "Guest details erased from reservations. Delete the contact itself in CRM.").then((x) => x && reload()); }}>Erase guest data</button>
                </div>
              )}
            </>
          )}
        </State>
      </div>
    </div>
  );
}
