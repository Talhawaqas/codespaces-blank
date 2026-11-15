"use client";

// src/components/business/hospitality/Admin.js
//
// Campaigns (a doorway into the existing Campaigns module, never a second sender), Reports and Settings
// (locations, hours, reservation policy, seating, staff roles, integration status) for Hospitality OS.

import { useState } from "react";
import { api, H, send, panel, row, input, primary, ghost, danger, muted, h3, label, today, addDays, useLoad, useAction, Msg, Field, State, Stat, Rate, Confirm } from "./shared";

// ================= Campaigns =================
export function CampaignsTab() {
  return (
    <div className="space-y-4">
      <div className={panel}>
        <h3 className={h3}>Guest email campaigns</h3>
        <p className="text-sm text-[var(--inaya-text-primary)]">Campaigns for guests are built, approved and sent in the Campaigns module, so there is one sender, one unsubscribe list and one approval step for the whole company.</p>
        <ul className={`${muted} list-disc pl-5 mt-3 space-y-1`}>
          <li>Guests who ticked the marketing box when booking are recorded as opted in, with the reservation as the source.</li>
          <li>In Campaigns, build an audience with &quot;Guest visits&quot; (visited recently, not visited recently, never visited) and keep &quot;Opted in only&quot; switched on.</li>
          <li>Unsubscribed, bounced and complained addresses are always left out, and a bulk send needs an approver.</li>
          <li>Booking confirmations and reminders are not marketing: they are sent whether or not a guest opted in, and never carry promotions.</li>
        </ul>
        <div className="flex gap-2 mt-4 flex-wrap"><a className={primary} href="/business?view=campaigns">Open Campaigns</a><a className={ghost} href="/business?view=crm">Open CRM</a><a className={ghost} href="/business?view=workflows">Open Automations</a></div>
      </div>
      <p className={muted}>Delivery, bounce and unsubscribe figures come from the email provider and are shown under Reports. An open is not proof that someone read an email.</p>
    </div>
  );
}

// ================= Reports =================
const Dist = ({ title, map }) => (
  <div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">{title}</h4>
    {Object.entries(map || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => <p key={k} className={muted}>{label(k)}: {v}</p>)}</div>
);
export function ReportsTab({ orgId, locationId, locations }) {
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(addDays(today(), -29));
  const [scope, setScope] = useState(locationId);
  const [r, , error, loading] = useLoad(() => api(H(orgId, "reports", { locationId: scope, from, to })), [orgId, scope, from, to]);
  const Empty = ({ x }) => <p className={muted}>{x.note || `Not enough data yet (${x.have ?? 0} of ${x.needed ?? "a few"} needed).`}</p>;
  return (
    <div className="space-y-4">
      <div className={`${panel} flex gap-3 flex-wrap items-end`}>
        <Field label="From"><input type="date" className={input} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className={input} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
        <Field label="Location"><select className={input} value={scope} onChange={(e) => setScope(e.target.value)}><option value="">All my locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <a className={ghost} href={H(orgId, "reports", { locationId: scope, from, to, format: "csv" })}>Download CSV</a>
      </div>
      <State loading={loading} error={error}>
        {r && (
          <>
            <div className={panel}>
              <h3 className={h3}>Reservations, {r.range.from} to {r.range.to}</h3>
              <div className="flex gap-3 flex-wrap mb-3"><Stat label="Reservations" value={r.reservations.total} /><Stat label="Guests served" value={r.reservations.covers} /><Stat label="Private events" value={r.reservations.privateEvents} /><Rate label="No-show rate" r={r.noShowRate} /><Rate label="Cancellation rate" r={r.cancellationRate} /><Rate label="Repeat guests" r={r.repeatGuests} /><Rate label="Waitlist seated" r={r.waitlistConversion} /></div>
              <div className="grid sm:grid-cols-3 gap-4"><Dist title="By status" map={r.reservations.byStatus} />{r.sourceMix.status === "ok" ? <Dist title="How bookings came in" map={r.sourceMix.bySource} /> : <div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">How bookings came in</h4><Empty x={r.sourceMix} /></div>}<div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Guest feedback</h4>{r.feedback.status === "ok" ? <p className={muted}>{r.feedback.average}/5 from {r.feedback.responses} responses</p> : <Empty x={r.feedback} />}</div></div>
            </div>
            <div className={panel}>
              <h3 className={h3}>Stock and purchasing</h3>
              <div className="grid sm:grid-cols-3 gap-4">
                <div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Wastage</h4>{r.wastage.status === "ok" ? <>{r.wastage.byIngredient.slice(0, 8).map((w) => <p key={w.name} className={muted}>{w.name}: {w.quantity} {w.unit}</p>)}<Dist title="By reason" map={r.wastage.byReason} /></> : <Empty x={r.wastage} />}</div>
                <div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Stock count differences</h4>{r.inventoryVariance.status === "ok" ? <><p className={muted}>{r.inventoryVariance.linesWithVariance} of {r.inventoryVariance.linesCounted} lines differed</p>{r.inventoryVariance.largest.slice(0, 6).map((l) => <p key={l.name} className={muted}>{l.name}: {l.system} → {l.counted} ({l.variancePercent}%)</p>)}</> : <Empty x={r.inventoryVariance} />}</div>
                <div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Purchase orders by supplier</h4>{r.purchaseSpend.status === "ok" ? <>{r.purchaseSpend.bySupplier.slice(0, 8).map((s) => <p key={s.supplier + s.currency} className={muted}>{s.supplier}: {s.value.toLocaleString()} {s.currency}</p>)}<p className={muted}>{r.purchaseSpend.note}</p></> : <Empty x={r.purchaseSpend} />}</div>
              </div>
            </div>
            <div className={panel}>
              <h3 className={h3}>Operations and campaigns</h3>
              <div className="grid sm:grid-cols-3 gap-4">
                <div><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Checklists</h4>{r.checklists.status === "ok" ? <p className={muted}>{r.checklists.completed} of {r.checklists.started} completed</p> : <Empty x={r.checklists} />}</div>
                <div>{r.incidents.status === "ok" ? <><p className={muted}>{r.incidents.total} incidents, {r.incidents.open} still open</p><Dist title="Incidents by type" map={r.incidents.byCategory} /></> : <><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Incidents</h4><Empty x={r.incidents} /></>}</div>
                <div>{r.campaigns.status === "ok" ? <><Dist title="Campaign emails (provider-reported)" map={r.campaigns.byStatus} /><p className={muted}>{r.campaigns.note}</p></> : <><h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-1">Campaign emails</h4><p className={muted}>{r.campaigns.note || "Not available."}</p></>}</div>
              </div>
            </div>
            <details className={panel}><summary className="text-sm text-[var(--inaya-text-primary)] cursor-pointer">How each figure is calculated</summary><div className="mt-3 space-y-1">{Object.entries(r.definitions).map(([k, v]) => <p key={k} className={muted}><strong>{label(k.replace(/([A-Z])/g, " $1"))}:</strong> {v}</p>)}</div></details>
          </>
        )}
      </State>
    </div>
  );
}

// ================= Settings =================
const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const hoursToText = (h) => DAYS.map(([d]) => (h?.[d] || []).map((p) => `${p.from}-${p.to}`).join(", "));
const textToHours = (lines) => Object.fromEntries(DAYS.map(([d], i) => [d, String(lines[i] || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [from, to] = s.split("-").map((x) => x.trim()); return { from, to }; })]));

export function SettingsTab({ orgId, can, canManage, location, locations, reloadOverview, options }) {
  const [sub, setSub] = useState(locations.length ? "location" : "new");
  const tabs = [["location", "This location"], ["seating", "Tables & seating"], ["new", "Add a location"], ...(can.manage ? [["roles", "Roles & access"]] : []), ["integrations", "Integrations"]];
  if (!can.manage) return <IntegrationsPanel orgId={orgId} />;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap">{tabs.map(([k, t]) => <button key={k} onClick={() => setSub(k)} aria-pressed={sub === k} className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg border ${sub === k ? "border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{t}</button>)}</div>
      {sub === "location" && (location ? <LocationForm key={location.id} orgId={orgId} location={location} options={options} onSaved={reloadOverview} /> : <p className={muted}>Add a location first.</p>)}
      {sub === "new" && <LocationForm key="new" orgId={orgId} location={null} options={options} onSaved={() => { reloadOverview(); setSub("seating"); }} />}
      {sub === "seating" && (location ? <Seating orgId={orgId} location={location} /> : <p className={muted}>Add a location first.</p>)}
      {sub === "roles" && <Roles orgId={orgId} locations={locations} canManage={canManage} options={options} />}
      {sub === "integrations" && <IntegrationsPanel orgId={orgId} />}
    </div>
  );
}

function LocationForm({ orgId, location, options, onSaved }) {
  const p = location?.policy || options?.defaultPolicy || {};
  let tz = "UTC"; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { tz = "UTC"; }
  const [f, setF] = useState({ name: location?.name || "", code: location?.code || "", address: location?.address || "", phone: location?.phone || "", email: location?.email || "", senderName: location?.senderName || "", timeZone: location?.timeZone || tz, currency: location?.currency || "USD", warehouseId: location?.warehouseId || "", publicSlug: location?.publicSlug || "", onlineBooking: !!location?.onlineBooking,
    hours: location ? hoursToText(location.hours) : DAYS.map(() => "12:00-15:00, 18:00-23:00"), closures: (location?.closures || []).map((c) => `${c.date} ${c.reason || ""}`.trim()).join("\n"),
    slotMinutes: p.slotMinutes ?? 15, leadMinutes: p.leadMinutes ?? 60, horizonDays: p.horizonDays ?? 60, maxPartyOnline: p.maxPartyOnline ?? 8, maxCoversPerSlot: p.maxCoversPerSlot ?? "", autoConfirm: p.autoConfirm !== false, confirmAbovePartySize: p.confirmAbovePartySize ?? "", cancelNoticeHours: p.cancelNoticeHours ?? 2, noShowGraceMinutes: p.noShowGraceMinutes ?? 15, reminderHours: p.reminderHours ?? 24, lastSeatingMinutes: p.lastSeatingMinutes ?? 60, policyText: p.policyText || "",
    turnTimes: (p.turnTimes || []).map((t) => `${t.maxParty}:${t.minutes}`).join(", ") });
  const [wh] = useLoad(() => api(H(orgId, "warehouses")).catch(() => ({ warehouses: [] })), [orgId]);
  const { busy, msg, run } = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const num = (v) => (v === "" || v === null ? null : Number(v));
  const save = (e) => {
    e.preventDefault();
    const body = { name: f.name, code: f.code, address: f.address, phone: f.phone, email: f.email, senderName: f.senderName, timeZone: f.timeZone, currency: f.currency, warehouseId: f.warehouseId || null, hours: textToHours(f.hours),
      closures: f.closures.split("\n").map((s) => s.trim()).filter(Boolean).map((s) => ({ date: s.slice(0, 10), reason: s.slice(10).trim() })),
      policy: { slotMinutes: Number(f.slotMinutes), leadMinutes: Number(f.leadMinutes), horizonDays: Number(f.horizonDays), maxPartyOnline: Number(f.maxPartyOnline), maxCoversPerSlot: num(f.maxCoversPerSlot), autoConfirm: f.autoConfirm, confirmAbovePartySize: num(f.confirmAbovePartySize), cancelNoticeHours: Number(f.cancelNoticeHours), noShowGraceMinutes: Number(f.noShowGraceMinutes), reminderHours: Number(f.reminderHours), lastSeatingMinutes: Number(f.lastSeatingMinutes), policyText: f.policyText, turnTimes: f.turnTimes.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [a, b] = s.split(":"); return { maxParty: Number(a), minutes: Number(b) }; }) },
      ...(location ? { publicSlug: f.publicSlug, onlineBooking: f.onlineBooking } : {}) };
    run(() => send(orgId, location ? `locations/${location.id}` : "locations", location ? "PATCH" : "POST", body), location ? "Location saved." : "Location added. Now add its seating areas and tables.").then((x) => x && onSaved());
  };
  const N = ({ k, text, hint, ...rest }) => <Field label={text} hint={hint}><input className={`${input} w-32`} type="number" min="0" value={f[k]} onChange={set(k)} {...rest} /></Field>;
  return (
    <form className="space-y-4" onSubmit={save}>
      <div className={`${panel} space-y-3`}>
        <h3 className={h3}>{location ? `Location: ${location.name}` : "New location"}</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Name"><input className={input} required value={f.name} onChange={set("name")} /></Field>
          <Field label="Internal code"><input className={input} value={f.code} onChange={set("code")} /></Field>
          <Field label="Time zone" hint="For example Asia/Karachi"><input className={input} required value={f.timeZone} onChange={set("timeZone")} /></Field>
          <Field label="Currency" hint="Three letters, for example PKR"><input className={input} required maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="Address" className="sm:col-span-2"><input className={input} value={f.address} onChange={set("address")} /></Field>
          <Field label="Phone"><input className={input} value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Email for guest replies"><input className={input} type="email" value={f.email} onChange={set("email")} /></Field>
          <Field label="Name shown on guest emails"><input className={input} value={f.senderName} onChange={set("senderName")} /></Field>
          <Field label="Stock location" hint="Where this location's ingredients are kept in Inventory"><select className={input} value={f.warehouseId} onChange={set("warehouseId")}><option value="">Not linked</option>{(wh?.warehouses || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        </div>
      </div>
      <div className={`${panel} space-y-3`}>
        <h3 className={h3}>Opening hours</h3>
        <p className={muted}>Service periods for each day, for example 12:00-15:00, 18:00-23:00. Leave a day empty if you&apos;re closed. Times are on the quarter hour.</p>
        <div className="grid sm:grid-cols-2 gap-3">{DAYS.map(([d, t], i) => <Field key={d} label={t}><input className={input} value={f.hours[i]} onChange={(e) => setF({ ...f, hours: f.hours.map((x, n) => (n === i ? e.target.value : x)) })} placeholder="Closed" /></Field>)}</div>
        <Field label="Closed dates, one per line" hint="For example 2026-12-25 Christmas Day"><textarea className={`${input} h-20`} value={f.closures} onChange={set("closures")} /></Field>
      </div>
      <div className={`${panel} space-y-3`}>
        <h3 className={h3}>Reservation policy</h3>
        <div className="flex gap-3 flex-wrap">
          <Field label="Booking times every"><select className={input} value={f.slotMinutes} onChange={set("slotMinutes")}><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></Field>
          <N k="leadMinutes" text="Minimum notice (minutes)" /><N k="horizonDays" text="Book up to (days ahead)" min="1" /><N k="lastSeatingMinutes" text="Last seating before close (minutes)" />
          <N k="maxPartyOnline" text="Largest party online" min="1" /><N k="maxCoversPerSlot" text="Most guests at one time" hint="Empty for no limit" /><N k="confirmAbovePartySize" text="Confirm by hand above (guests)" hint="Empty for never" />
          <N k="cancelNoticeHours" text="Guests can cancel until (hours before)" /><N k="noShowGraceMinutes" text="No-show after (minutes late)" /><N k="reminderHours" text="Reminder email (hours before)" hint="0 for none" />
        </div>
        <Field label="How long a table is held, by party size" hint="Largest party:minutes, for example 2:90, 4:105, 6:120, 99:150"><input className={input} value={f.turnTimes} onChange={set("turnTimes")} /></Field>
        <label className="flex items-center gap-2 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={f.autoConfirm} onChange={set("autoConfirm")} /> Confirm online bookings automatically (otherwise each one waits for a host)</label>
        <Field label="Policy shown to guests" hint="Cancellation and no-show terms, in your own words"><textarea className={`${input} h-20`} value={f.policyText} onChange={set("policyText")} /></Field>
      </div>
      {location && (
        <div className={`${panel} space-y-3`}>
          <h3 className={h3}>Online booking page</h3>
          <div className="flex gap-3 flex-wrap items-end"><Field label="Web address" hint={f.publicSlug ? `Guests book at /reserve/${f.publicSlug}` : "Lowercase letters, numbers and hyphens"}><input className={input} value={f.publicSlug} onChange={(e) => setF({ ...f, publicSlug: e.target.value.toLowerCase() })} placeholder="my-restaurant" /></Field>
            <label className="flex items-center gap-2 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={f.onlineBooking} onChange={set("onlineBooking")} /> Accept bookings online</label>
            {location.onlineBooking && location.publicSlug && <a className={ghost} href={`/reserve/${location.publicSlug}`} target="_blank" rel="noreferrer">Open the page</a>}</div>
          <p className={muted}>The page shows only your name, address, hours and free times. It is rate-limited and never shows guest or staff information. Card details are never taken.</p>
        </div>
      )}
      <Msg msg={msg} />
      <button className={primary} disabled={busy}>{location ? "Save location" : "Add location"}</button>
    </form>
  );
}

function Seating({ orgId, location }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, `locations/${location.id}/seating`)), [orgId, location.id]);
  const { busy, msg, run } = useAction();
  const [edit, setEdit] = useState(null);
  const act = (fn, ok) => run(fn, ok).then((x) => { if (x) { setEdit(null); reload(); } });
  return (
    <div className="space-y-4">
      <Msg msg={msg} />
      <form className={`${panel} flex gap-3 items-end flex-wrap`} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); act(() => send(orgId, `locations/${location.id}/areas`, "POST", { name: fd.get("name") }), "Area added.").then(() => e.target.reset()); }}>
        <Field label="New seating area"><input name="name" className={input} placeholder="Indoor, Patio, Private room" required /></Field><button className={ghost} disabled={busy}>Add area</button>
      </form>
      <State loading={loading} error={error} empty={data && !data.areas.length} emptyText="Add a seating area, then its tables.">
        {(data?.areas || []).map((a) => (
          <div key={a.id} className={panel}>
            <div className="flex justify-between items-center gap-2 flex-wrap mb-3"><h3 className="text-[var(--inaya-text-primary)] font-semibold text-sm">{a.name}{a.closed ? " (closed)" : ""}</h3>
              <span className="flex gap-2"><button className={ghost} disabled={busy} onClick={() => act(() => send(orgId, `locations/${location.id}/areas`, "POST", { areaId: a.id, name: a.name, order: a.order, closed: !a.closed }), a.closed ? "Area reopened." : "Area closed: its tables can't be booked.")}>{a.closed ? "Reopen" : "Close area"}</button>
                <Confirm text={`Remove the area "${a.name}"?`} className={danger} disabled={busy} onYes={() => act(() => api(H(orgId, `locations/${location.id}/areas/${a.id}`), { method: "DELETE", body: JSON.stringify({ orgId }) }), "Area removed.")}>Remove</Confirm></span></div>
            <div className="space-y-2">
              {data.tables.filter((t) => t.areaId === a.id).map((t) => (
                <div key={t.id} className={row}>
                  <span className="text-sm text-[var(--inaya-text-primary)]">Table {t.label} · seats {t.minParty} to {t.maxParty}{t.active ? "" : " · out of use"}{t.combinableWith.length ? ` · combines with ${t.combinableWith.map((x) => data.tables.find((y) => y.id === x)?.label).filter(Boolean).join(", ")}` : ""}{t.blocks.length ? ` · ${t.blocks.length} planned closure${t.blocks.length > 1 ? "s" : ""}` : ""}</span>
                  <span className="flex gap-2"><button className={ghost} onClick={() => setEdit({ ...t })}>Edit</button><Confirm text={`Remove table ${t.label}?`} className={danger} disabled={busy} onYes={() => act(() => api(H(orgId, `locations/${location.id}/tables/${t.id}`), { method: "DELETE", body: JSON.stringify({ orgId }) }), "Table removed.")}>Remove</Confirm></span>
                </div>
              ))}
              <button className={ghost} onClick={() => setEdit({ areaId: a.id, label: "", minParty: 1, maxParty: 4, active: true, combinableWith: [], blocks: [] })}>Add a table</button>
            </div>
          </div>
        ))}
      </State>
      {edit && (
        <form className={`${panel} space-y-3`} onSubmit={(e) => { e.preventDefault(); act(() => send(orgId, `locations/${location.id}/tables`, "POST", { tableId: edit.id, areaId: edit.areaId, label: edit.label, minParty: Number(edit.minParty), maxParty: Number(edit.maxParty), active: edit.active, combinableWith: edit.combinableWith, blocks: edit.blocks }), "Table saved."); }}>
          <h3 className={h3}>{edit.id ? `Table ${edit.label}` : "New table"}</h3>
          <div className="flex gap-3 flex-wrap items-end">
            <Field label="Number or name"><input className={`${input} w-28`} required value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
            <Field label="Smallest party"><input className={`${input} w-24`} type="number" min="1" value={edit.minParty} onChange={(e) => setEdit({ ...edit, minParty: e.target.value })} /></Field>
            <Field label="Largest party"><input className={`${input} w-24`} type="number" min="1" value={edit.maxParty} onChange={(e) => setEdit({ ...edit, maxParty: e.target.value })} /></Field>
            <Field label="Area"><select className={input} value={edit.areaId} onChange={(e) => setEdit({ ...edit, areaId: e.target.value })}>{data.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="Can be combined with" hint="Hold Ctrl to pick several"><select multiple className={`${input} h-24`} value={edit.combinableWith} onChange={(e) => setEdit({ ...edit, combinableWith: [...e.target.selectedOptions].map((o) => o.value) })}>{data.tables.filter((t) => t.id !== edit.id).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
            <label className="flex items-center gap-2 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> In use</label>
          </div>
          {edit.blocks.map((b, n) => (
            <div key={n} className="flex gap-2 flex-wrap items-end">
              <Field label="Closed from"><input type="datetime-local" className={input} value={String(b.fromLocal || b.from).slice(0, 16)} onChange={(e) => setEdit({ ...edit, blocks: edit.blocks.map((x, i) => (i === n ? { ...x, from: e.target.value, fromLocal: e.target.value } : x)) })} /></Field>
              <Field label="Until"><input type="datetime-local" className={input} value={String(b.toLocal || b.to).slice(0, 16)} onChange={(e) => setEdit({ ...edit, blocks: edit.blocks.map((x, i) => (i === n ? { ...x, to: e.target.value, toLocal: e.target.value } : x)) })} /></Field>
              <Field label="Reason"><input className={input} value={b.reason || ""} onChange={(e) => setEdit({ ...edit, blocks: edit.blocks.map((x, i) => (i === n ? { ...x, reason: e.target.value } : x)) })} /></Field>
              <button type="button" className={danger} onClick={() => setEdit({ ...edit, blocks: edit.blocks.filter((_, i) => i !== n) })}>Remove</button>
            </div>
          ))}
          <button type="button" className={ghost} onClick={() => setEdit({ ...edit, blocks: [...edit.blocks, { from: "", to: "", reason: "" }] })}>Add a temporary closure</button>
          <div className="flex gap-2"><button className={primary} disabled={busy}>Save table</button><button type="button" className={ghost} onClick={() => setEdit(null)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

const ROLE_HELP = { manager: "Everything at their locations, including approvals and reports", host: "Reservations, waitlist and guest notes", service: "Today's reservations (no contact details or staff notes), seating, checklists", kitchen: "Menu drafts, recipes, wastage, checklists", stock: "Counts, wastage, reorder requests, deliveries" };
function Roles({ orgId, locations, canManage, options }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "staff-roles")), [orgId]);
  const { busy, msg, run } = useAction();
  const save = (email, body) => run(() => send(orgId, "staff-roles", "PUT", { email, ...body }), "Saved.").then((x) => x && reload());
  return (
    <div className={`${panel} space-y-3`}>
      <h3 className={h3}>Roles and access</h3>
      <div className="space-y-1">{(options?.roles || []).map((r) => <p key={r} className={muted}><strong>{label(r)}:</strong> {ROLE_HELP[r]}</p>)}<p className={muted}>Owners and admins can do everything at every location. Marketing and finance keep their own roles in Campaigns and Finance. With more than one location, each person only sees the locations ticked for them.</p></div>
      {!canManage && <p className="text-amber-400 text-[12px]">Only the company owner or an admin can change roles.</p>}
      <Msg msg={msg} />
      <State loading={loading} error={error}>
        <div className="space-y-2">{(data?.staff || []).map((s) => (
          <div key={s.email} className={row}>
            <span className="text-sm text-[var(--inaya-text-primary)]">{s.name || s.email} <span className={muted}>{s.name ? s.email : ""} · {label(s.role)}</span></span>
            <span className="flex gap-2 items-center flex-wrap">
              <select className={input} disabled={!canManage || busy} value={s.hospitalityRole || ""} aria-label={`Hospitality role for ${s.email}`} onChange={(e) => save(s.email, { hospitalityRole: e.target.value || null })}><option value="">No hospitality role</option>{(options?.roles || []).map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>
              {locations.length > 1 && locations.map((l) => <label key={l.id} className="flex items-center gap-1 text-[11px] text-[var(--inaya-text-muted)]"><input type="checkbox" disabled={!canManage || busy} checked={s.locationIds.includes(l.id)} onChange={(e) => save(s.email, { locationIds: e.target.checked ? [...s.locationIds, l.id] : s.locationIds.filter((x) => x !== l.id) })} />{l.name}</label>)}
            </span>
          </div>
        ))}</div>
      </State>
    </div>
  );
}

const STATUS_TEXT = { connected_verified: ["Connected and verified", "text-emerald-400"], configured_not_verified: ["Configured, not verified", "text-amber-400"], available: ["Available to set up", "text-[var(--inaya-text-muted)]"], planned: ["Planned", "text-[var(--inaya-text-muted)]"], unsupported: ["Not supported", "text-[var(--inaya-text-muted)]"] };
function IntegrationsPanel({ orgId }) {
  const [data, , error, loading] = useLoad(() => api(H(orgId, "integrations")), [orgId]);
  return (
    <div className={`${panel} space-y-3`}>
      <h3 className={h3}>Integrations</h3>
      <p className={muted}>An integration is only called connected when the other system has confirmed it.</p>
      <State loading={loading} error={error}>
        <div className="space-y-2">{(data?.integrations || []).map((i) => (
          <div key={i.id} className={row}><span className="text-sm text-[var(--inaya-text-primary)]">{i.name}<span className={`${muted} block`}>{i.category} · {i.detail}</span></span><span className={`text-[12px] ${STATUS_TEXT[i.status][1]}`}>{STATUS_TEXT[i.status][0]}</span></div>
        ))}</div>
        <p className={muted}>{data?.webhooks?.note} <a className="underline" href="/business?view=integrations">Open Integrations</a></p>
      </State>
    </div>
  );
}
