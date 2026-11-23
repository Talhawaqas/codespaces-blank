"use client";

// src/components/business/GrowthView.js -- Inaya Commerce Phase 4 (Master SOW section 8): Customer 360, loyalty and
// memberships, gift cards and store credit, promotions, marketing automation, duplicates and the growth assistant.
// Every action is checked again on the server (src/lib/growth/*). Policies shown here are the owner's (22 Nov 2026):
// gift cards / store credit are a liability until spent (no expiry by default; write-offs need two managers); loyalty
// points are a ledger with a liability report and are not posted to the books.

import { useState, useEffect, useCallback } from "react";
import { useErpSection } from "./erp/ErpNavContext";

const f = "w-full min-h-[38px] bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-lg px-2.5 text-sm text-[var(--inaya-text-primary)]";
const pb = "min-h-[38px] px-3 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40";
const gb = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] disabled:opacity-40";
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-3";
const mu = "text-[var(--inaya-text-muted)]";
const money = (v) => (v === null || v === undefined ? "–" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
async function api(path, { orgId, method = "GET", body } = {}) {
  const r = await fetch(`/api/orgs/growth/${path}${method === "GET" ? `${path.includes("?") ? "&" : "?"}orgId=${orgId}` : ""}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify({ orgId, ...body }) } : {}) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { code: d.code }); return d;
}
const Msg = ({ ok, err }) => <>{ok && <p className="text-sm text-emerald-600">{ok}</p>}{err && <p className="text-sm text-red-500" role="alert">{err}</p>}</>;
const H = ({ children }) => <h3 className="font-bold text-sm text-[var(--inaya-text-primary)] mb-2">{children}</h3>;
function useAction() { const [ok, setOk] = useState(""); const [err, setErr] = useState(""); const run = async (fn, msg) => { setOk(""); setErr(""); try { const r = await fn(); if (msg) setOk(typeof msg === "function" ? msg(r) : msg); return r; } catch (e) { setErr(e.message); return null; } }; return { ok, err, run, setErr }; }

export default function GrowthView({ orgId }) {
  const tabs = [["customers", "Customers"], ["loyalty", "Loyalty & members"], ["cards", "Gift cards"], ["promotions", "Promotions"], ["automation", "Automation"], ["duplicates", "Duplicates"], ["assistant", "Assistant"]];
  const [tab, setTab] = useErpSection("customers", tabs);
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2" role="tablist" data-erp-tabs>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? pb : gb} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "customers" && <Customers orgId={orgId} />}
    {tab === "loyalty" && <Loyalty orgId={orgId} />}
    {tab === "cards" && <Cards orgId={orgId} />}
    {tab === "promotions" && <Promotions orgId={orgId} />}
    {tab === "automation" && <Automation orgId={orgId} />}
    {tab === "duplicates" && <Duplicates orgId={orgId} />}
    {tab === "assistant" && <Assistant orgId={orgId} />}
  </div>;
}

// ================================================================ Customers (360)
function Customers({ orgId }) {
  const [list, setList] = useState([]); const [q, setQ] = useState(""); const [sel, setSel] = useState(null);
  useEffect(() => { fetch(`/api/orgs/crm/contacts?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setList((d.contacts || []).filter((c) => c.type !== "LEAD"))).catch(() => {}); }, [orgId]);
  const shown = list.filter((c) => !q || `${c.name} ${c.email || ""} ${c.phone || ""} ${c.company || ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
    <div className={`${card} space-y-2`}><input aria-label="Find a customer" className={f} placeholder="Name, email, phone or company" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="divide-y divide-[var(--inaya-border)] max-h-[60vh] overflow-auto">{shown.map((c) => <li key={c.id}><button className={`w-full text-left py-2 text-sm ${sel === c.id ? "font-bold" : ""}`} onClick={() => setSel(c.id)}>{c.name}<span className={`block text-xs ${mu}`}>{c.company || c.email || c.phone || ""}</span></button></li>)}</ul></div>
    {sel ? <Customer360 orgId={orgId} id={sel} key={sel} /> : <div className={card}><p className={mu}>Choose a customer to see everything about them in one place: purchases, orders, invoices, support, bookings, loyalty, gift cards and emails.</p></div>}
  </div>;
}
function Customer360({ orgId, id }) {
  const [tl, setTl] = useState(null); const [intel, setIntel] = useState(null); const [loy, setLoy] = useState(null); const [cards, setCards] = useState([]); const [sum, setSum] = useState(null); const [next, setNext] = useState(null); const [edit, setEdit] = useState(false); const a = useAction();
  const load = useCallback(() => {
    api(`customers/${id}/timeline`, { orgId }).then(setTl).catch((e) => a.setErr(e.message));
    api(`customers/${id}/intelligence`, { orgId }).then(setIntel).catch(() => {});
    api(`customers/${id}/loyalty`, { orgId }).then(setLoy).catch(() => setLoy(null));
    api(`customers/${id}/cards`, { orgId }).then((d) => setCards(d.cards)).catch(() => {});
    api(`assistant/summary?customerId=${id}`, { orgId }).then(setSum).catch(() => setSum(null));
    api(`assistant/next-products?customerId=${id}`, { orgId }).then(setNext).catch(() => setNext(null));
  }, [orgId, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (!tl) return <div className={card}><Msg err={a.err} /><p className={mu}>Loading…</p></div>;
  const p = tl.customer;
  return <div className="space-y-3">
    <div className={card}><div className="flex flex-wrap items-start gap-2"><div className="flex-1"><h2 className="font-bold text-lg">{p.name}</h2><p className={`text-sm ${mu}`}>{[p.company, p.email, p.phone].filter(Boolean).join(" · ")}</p>
      <p className="text-xs mt-1">{p.customerType.toLowerCase()} · account {p.accountStatus.toLowerCase()}{p.loyaltyTier ? ` · ${p.loyaltyTier} tier` : ""}{p.tags.length ? ` · ${p.tags.join(", ")}` : ""}{p.accountManagerEmail ? ` · manager ${p.accountManagerEmail}` : ""}</p></div><button className={gb} onClick={() => setEdit(!edit)}>{edit ? "Close" : "Edit profile"}</button></div>
      {edit && <ProfileEdit orgId={orgId} p={p} onSaved={() => { setEdit(false); load(); }} />}</div>
    {sum && <div className={card}><H>Relationship summary</H><p className="text-sm">{sum.summary}</p>{sum.action && <p className={`text-sm mt-1 ${mu}`}>{sum.action}</p>}</div>}
    {intel?.hasHistory && <div className={card}><H>Customer value</H>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">{[["Total spend", `${intel.currency} ${money(intel.totalSpend)}`], ["Purchases", intel.orders], ["Average sale", money(intel.aov)], ["Last bought", `${intel.recencyDays} days ago`], ["Segment", `${intel.rfm.label} (R${intel.rfm.r} F${intel.rfm.f} M${intel.rfm.m})`], ["Refund rate", `${intel.refundRate}%`], ["Lifetime value", `${money(intel.lifetimeValue.historical)} so far`], ["Estimate", intel.lifetimeValue.estimate === null ? "not enough history" : money(intel.lifetimeValue.estimate)]].map(([k, v]) => <div key={k}><p className={`text-xs ${mu}`}>{k}</p><p className="font-semibold">{v}</p></div>)}</div>
      {intel.atRisk && <p className="text-sm text-amber-600 mt-2">At risk: later than their usual buying gap.</p>}
      {intel.affinity.length > 0 && <p className={`text-xs ${mu} mt-1`}>Buys most: {intel.affinity.map((x) => `${x.category} (${money(x.spend)})`).join(", ")}</p>}
      <details className={`text-xs ${mu} mt-1`}><summary className="cursor-pointer">How these are calculated</summary>{Object.values(intel.definitions).map((d, i) => <p key={i}>{d}</p>)}</details></div>}
    {next?.suggestions?.length > 0 && <div className={card}><H>Suggested next products</H>{next.suggestions.map((s) => <p key={s.productId} className="text-sm">{s.name} <span className={mu}>· {s.why}</span></p>)}</div>}
    {loy?.enabled && <div className={card}><H>Loyalty</H><p className="text-sm">{loy.balance} points (worth {money(loy.value)}) · {loy.tier} tier{loy.nextTier ? ` · ${money(loy.nextTier.needed)} more to ${loy.nextTier.name}` : ""}{loy.member ? ` · member: ${loy.member.plan} until ${new Date(loy.member.endsAt).toLocaleDateString()}` : ""}</p>
      <details className="text-xs mt-1"><summary className={`cursor-pointer ${mu}`}>Points history</summary>{loy.ledger.map((l, i) => <p key={i}>{new Date(l.at).toLocaleDateString()} · {l.points > 0 ? "+" : ""}{l.points} · {l.type.toLowerCase().replaceAll("_", " ")}{l.reason ? ` · ${l.reason}` : ""}</p>)}</details>
      <AdjustPoints orgId={orgId} id={id} onDone={load} /></div>}
    {cards.length > 0 && <div className={card}><H>Gift cards & store credit</H>{cards.map((k) => <p key={k.id} className="text-sm">{k.type === "STORE_CREDIT" ? "Store credit" : "Gift card"} ••{k.last4} · {money(k.balance)} · {k.status.toLowerCase()}</p>)}</div>}
    <div className={card}><H>Timeline</H><Msg err={a.err} /><ul className="divide-y divide-[var(--inaya-border)]">{tl.events.map((e, i) => <li key={i} className="py-1.5 text-sm flex gap-2"><span className={`w-24 shrink-0 text-xs ${mu}`}>{e.at ? new Date(e.at).toLocaleDateString() : ""}</span><span className="flex-1">{e.title}{e.detail ? <span className={mu}> · {e.detail}</span> : null}</span>{e.amount !== undefined && e.amount !== null && <span className="font-mono">{money(e.amount)}</span>}</li>)}</ul>{!tl.events.length && <p className={mu}>Nothing yet.</p>}</div>
  </div>;
}
function ProfileEdit({ orgId, p, onSaved }) {
  const [x, setX] = useState({ customerType: p.customerType, accountStatus: p.accountStatus, accountManagerEmail: p.accountManagerEmail || "", creditLimit: p.creditLimit ?? "", birthday: p.birthday || "", tags: p.tags.join(", "), sourceChannel: p.sourceChannel || "", prefs: p.contactPreferences });
  const a = useAction();
  return <div className="grid md:grid-cols-2 gap-2 mt-3 text-sm">
    <label>Type<select className={f} value={x.customerType} onChange={(e) => setX({ ...x, customerType: e.target.value })}><option value="INDIVIDUAL">Individual</option><option value="BUSINESS">Business</option></select></label>
    <label>Account<select className={f} value={x.accountStatus} onChange={(e) => setX({ ...x, accountStatus: e.target.value })}><option value="ACTIVE">Active</option><option value="ON_HOLD">On hold</option><option value="CLOSED">Closed</option></select></label>
    <label>Account manager (email)<input className={f} value={x.accountManagerEmail} onChange={(e) => setX({ ...x, accountManagerEmail: e.target.value })} /></label>
    <label>Credit limit (finance access)<input className={f} inputMode="decimal" value={x.creditLimit} onChange={(e) => setX({ ...x, creditLimit: e.target.value })} /></label>
    <label>Birthday (MM-DD, for a birthday greeting if they agree)<input className={f} placeholder="03-14" value={x.birthday} onChange={(e) => setX({ ...x, birthday: e.target.value })} /></label>
    <label>Where they came from<input className={f} placeholder="walk-in, referral, Instagram…" value={x.sourceChannel} onChange={(e) => setX({ ...x, sourceChannel: e.target.value })} /></label>
    <label className="md:col-span-2">Tags (comma separated)<input className={f} value={x.tags} onChange={(e) => setX({ ...x, tags: e.target.value })} /></label>
    <div className="md:col-span-2 flex flex-wrap gap-3">{["email", "sms", "phone", "post"].map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={!!x.prefs[k]} onChange={(e) => setX({ ...x, prefs: { ...x.prefs, [k]: e.target.checked } })} /> OK to contact by {k}</label>)}</div>
    <div className="md:col-span-2"><Msg ok={a.ok} err={a.err} /><button className={pb} onClick={() => a.run(async () => { await api(`customers/${p.id}/profile`, { orgId, method: "PUT", body: { customerType: x.customerType, accountStatus: x.accountStatus, accountManagerEmail: x.accountManagerEmail || null, ...(x.creditLimit !== "" && x.creditLimit !== (p.creditLimit ?? "") ? { creditLimit: Number(x.creditLimit) } : {}), birthday: x.birthday || null, tags: x.tags.split(",").map((t) => t.trim()).filter(Boolean), sourceChannel: x.sourceChannel || null, contactPreferences: x.prefs } }); onSaved(); })}>Save profile</button></div>
  </div>;
}
function AdjustPoints({ orgId, id, onDone }) {
  const a = useAction();
  return <div className="mt-2"><button className={gb} onClick={() => { const pts = window.prompt("Add (positive) or remove (negative) points"); if (!pts) return; const reason = window.prompt("Reason (kept in the points history)"); if (!reason) return; a.run(async () => { await api("loyalty/adjust", { orgId, method: "POST", body: { customerId: id, points: Number(pts), reason } }); onDone(); }, "Points adjusted."); }}>Adjust points (manager)</button><Msg ok={a.ok} err={a.err} /></div>;
}

// ================================================================ Loyalty & memberships
function Loyalty({ orgId }) {
  const [s, setS] = useState(null); const [lia, setLia] = useState(null); const [plans, setPlans] = useState([]); const [plan, setPlan] = useState({ name: "", fee: "", durationMonths: 12, discountPercent: 5, pointsMultiplier: 1 }); const a = useAction();
  const load = useCallback(() => { api("loyalty/settings", { orgId }).then((d) => setS(d.settings)); api("loyalty/liability", { orgId }).then(setLia).catch(() => {}); api("plans", { orgId }).then((d) => setPlans(d.plans)); }, [orgId]);
  useEffect(() => { load(); }, [load]);
  if (!s) return <p className={mu}>Loading…</p>;
  const num = (k, div = 1) => <input aria-label={k} className={f} inputMode="decimal" value={s[k] / div} onChange={(e) => setS({ ...s, [k]: Math.round(Number(e.target.value) * div) })} />;
  return <div className="grid gap-3 lg:grid-cols-2">
    <div className={`${card} space-y-2 text-sm`}><H>Points programme</H>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Loyalty points switched on</label>
      <div className="grid grid-cols-2 gap-2"><label>Spend per point earned{num("earnUnitMinor", 100)}</label><label>Points each time<input className={f} inputMode="decimal" value={s.pointsPerUnit} onChange={(e) => setS({ ...s, pointsPerUnit: Number(e.target.value) })} /></label>
        <label>Value of 1 point{num("pointValueMinor", 100)}</label><label>Minimum points to use<input className={f} value={s.minRedeemPoints} onChange={(e) => setS({ ...s, minRedeemPoints: Number(e.target.value) })} /></label>
        <label>Max % of a sale paid with points<input className={f} value={s.maxRedeemPercent} onChange={(e) => setS({ ...s, maxRedeemPercent: Number(e.target.value) })} /></label><label>Points expire after (months, 0 = never)<input className={f} value={s.expiryMonths} onChange={(e) => setS({ ...s, expiryMonths: Number(e.target.value) })} /></label>
        <label>Daily earning cap (abuse control)<input className={f} value={s.dailyEarnCap} onChange={(e) => setS({ ...s, dailyEarnCap: Number(e.target.value) })} /></label></div>
      <p className={`text-xs ${mu}`}>Tiers (spend in the last 12 months): {s.tiers.map((t) => `${t.name} from ${money(t.minSpendMinor / 100)} ×${t.multiplier}`).join(" · ")}</p>
      <Msg ok={a.ok} err={a.err} /><button className={pb} onClick={() => a.run(() => api("loyalty/settings", { orgId, method: "PUT", body: s }), "Saved.")}>Save</button></div>
    <div className="space-y-3">
      <div className={`${card} text-sm`}><H>Points liability</H>{lia ? <><p>{lia.outstandingPoints.toLocaleString()} unused points held by {lia.members} customers, worth about <b>{money(lia.liabilityValue)}</b>.</p><p className={`text-xs ${mu}`}>{lia.note}</p></> : <p className={mu}>…</p>}</div>
      <div className={`${card} space-y-2 text-sm`}><H>Membership plans</H>{plans.map((p) => <p key={p.id}>{p.name} · fee {money(p.fee)} · {p.durationMonths} months · {p.discountPercent}% off · points ×{p.pointsMultiplier}</p>)}
        <div className="grid grid-cols-2 gap-2"><input aria-label="Plan name" className={f} placeholder="Plan name" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} /><input aria-label="Plan fee" className={f} placeholder="Fee" value={plan.fee} onChange={(e) => setPlan({ ...plan, fee: e.target.value })} />
          <input aria-label="Months" className={f} placeholder="Months" value={plan.durationMonths} onChange={(e) => setPlan({ ...plan, durationMonths: Number(e.target.value) })} /><input aria-label="Member discount %" className={f} placeholder="Member discount %" value={plan.discountPercent} onChange={(e) => setPlan({ ...plan, discountPercent: Number(e.target.value) })} /></div>
        <p className={`text-xs ${mu}`}>Fees are recorded by staff (cash, bank transfer or reference). Automatic recurring card billing needs a payment provider and separate approval.</p>
        <button className={gb} onClick={() => a.run(async () => { await api("plans", { orgId, method: "POST", body: { ...plan, fee: Number(plan.fee || 0) } }); load(); }, "Plan saved.")}>Add plan</button>
        <JoinPlan orgId={orgId} plans={plans} /></div>
    </div>
  </div>;
}
function JoinPlan({ orgId, plans }) {
  const [x, setX] = useState({ customerId: "", planId: "", method: "CASH", reference: "" }); const [list, setList] = useState([]); const a = useAction();
  useEffect(() => { fetch(`/api/orgs/crm/contacts?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setList(d.contacts || [])).catch(() => {}); }, [orgId]);
  return <div className="border-t border-[var(--inaya-border)] pt-2 space-y-2"><p className="font-semibold">Sign a customer up / renew</p>
    <div className="grid grid-cols-2 gap-2"><select aria-label="Member customer" className={f} value={x.customerId} onChange={(e) => setX({ ...x, customerId: e.target.value })}><option value="">Customer…</option>{list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select aria-label="Member plan" className={f} value={x.planId} onChange={(e) => setX({ ...x, planId: e.target.value })}><option value="">Plan…</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <select aria-label="Fee paid by" className={f} value={x.method} onChange={(e) => setX({ ...x, method: e.target.value })}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="MANUAL_REFERENCE">Other (reference)</option></select>
      {x.method !== "CASH" && <input aria-label="Fee reference" className={f} placeholder="Reference" value={x.reference} onChange={(e) => setX({ ...x, reference: e.target.value })} />}</div>
    <Msg ok={a.ok} err={a.err} /><button className={pb} disabled={!x.customerId || !x.planId} onClick={() => a.run(() => api("memberships", { orgId, method: "POST", body: { customerId: x.customerId, planId: x.planId, payment: { method: x.method, reference: x.reference } } }), (r) => `Member until ${new Date(r.member.endsAt).toLocaleDateString()}.`)}>Save membership</button></div>;
}

// ================================================================ Gift cards
function Cards({ orgId }) {
  const [lia, setLia] = useState(null); const [code, setCode] = useState(""); const [found, setFound] = useState(null); const a = useAction();
  const load = useCallback(() => api("cards/liability", { orgId }).then(setLia).catch((e) => a.setErr(e.message)), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return <div className="grid gap-3 lg:grid-cols-2">
    <div className={`${card} space-y-2 text-sm`}><H>Check or replace a card</H>
      <input aria-label="Gift card code" className={f} placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
      <div className="flex gap-2"><button className={gb} onClick={() => a.run(async () => setFound((await api("cards/balance", { orgId, method: "POST", body: { code } })).card))}>Check balance</button>
        <button className={gb} onClick={() => { const reason = window.prompt("Reason (e.g. reported lost)"); if (reason) a.run(async () => { const r = await api("cards/replace", { orgId, method: "POST", body: { code, reason } }); window.alert(`New card code (shown once, give it to the customer): ${r.newCard.code}`); load(); }, "Card blocked and balance moved to a new card."); }}>Lost / stolen: replace</button></div>
      {found && <p>{found.type === "STORE_CREDIT" ? "Store credit" : "Gift card"} ••{found.last4}: <b>{money(found.balance)}</b> of {money(found.initial)} · {found.status.toLowerCase()}{found.expiresAt ? ` · expires ${new Date(found.expiresAt).toLocaleDateString()}` : " · no expiry"}</p>}
      {found && found.balance > 0 && <button className={gb} onClick={() => { const reason = window.prompt("Why write this balance off as income? (another manager must approve)"); if (reason) a.run(() => api("cards/breakage", { orgId, method: "POST", body: { cardId: found.id, reason } }).then(load), "Write-off requested; another manager must approve."); }}>Request write-off</button>}
      <p className={`text-xs ${mu}`}>Gift cards are sold at the till like a product (a gift-card item; you enter the value). The code prints on the receipt once and is never stored in readable form.</p>
      <Msg ok={a.ok} err={a.err} /></div>
    <div className={`${card} text-sm space-y-2`}><H>Owed to customers</H>{lia ? <>{lia.byType.map((t) => <p key={t.type}>{t.type === "STORE_CREDIT" ? "Store credit" : "Gift cards"}: {t.cards} active, <b>{money(t.balance)}</b></p>)}<p>Total liability: <b>{money(lia.total)}</b></p><p className={`text-xs ${mu}`}>{lia.note} Unused balances are only written off with two managers' approval.</p>
      {lia.pendingBreakage.map((p) => <div key={p.id} className="border-t border-[var(--inaya-border)] pt-1"><p>Write-off of {money(p.amount)} requested by {p.requestedBy}: {p.reason}</p><div className="flex gap-2"><button className={pb} onClick={() => a.run(() => api(`cards/breakage/${p.id}/decide`, { orgId, method: "POST", body: { approve: true } }).then(load), "Approved.")}>Approve</button><button className={gb} onClick={() => a.run(() => api(`cards/breakage/${p.id}/decide`, { orgId, method: "POST", body: { approve: false } }).then(load), "Rejected.")}>Reject</button></div></div>)}</> : <p className={mu}>…</p>}</div>
  </div>;
}

// ================================================================ Promotions
function Promotions({ orgId }) {
  const [list, setList] = useState(null); const [x, setX] = useState({ name: "", type: "PERCENT", value: 10, code: "", categories: "", buyQty: 1, getQty: 1, minSpend: "", startsAt: "", endsAt: "", usageLimit: "", perCustomerLimit: "", stacking: "EXCLUSIVE", firstPurchaseOnly: false, membersOnly: false }); const a = useAction();
  const load = useCallback(() => api("promotions", { orgId }).then((d) => setList(d.promotions)).catch((e) => a.setErr(e.message)), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const act = (p, action) => a.run(() => api(`promotions/${p.id}/${action}`, { orgId, method: "POST", body: {} }).then(load), "Done.");
  return <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
    <div className={`${card} text-sm space-y-2`}><H>Offers</H><Msg ok={a.ok} err={a.err} />
      {!list ? <p className={mu}>Loading…</p> : !list.length ? <p className={mu}>No offers yet. Create one on the right; another manager approves it before it applies.</p> : list.map((p) => <div key={p.id} className="border-t border-[var(--inaya-border)] py-2">
        <p className="font-semibold">{p.name}{p.code ? <span className="font-mono"> · {p.code}</span> : null} <span className="text-xs uppercase">{p.status.toLowerCase()}</span></p>
        <p className={`text-xs ${mu}`}>{p.type === "PERCENT" ? `${p.value}% off` : p.type === "AMOUNT" ? `${money(p.value)} off` : `Buy ${p.buyQty} get ${p.getQty} ${p.value === 100 ? "free" : `${p.value}% off`}`}{p.categories.length ? ` · ${p.categories.join(", ")}` : p.productIds.length ? ` · ${p.productIds.length} product(s)` : " · everything"}{p.minSpend ? ` · min spend ${money(p.minSpend)}` : ""}{p.firstPurchaseOnly ? " · first purchase" : ""}{p.membersOnly ? " · members" : ""} · {p.stacking.toLowerCase()} · used {p.used}{p.usageLimit ? `/${p.usageLimit}` : ""} · gave {money(p.discountGiven)} off on {p.sales} sale(s) worth {money(p.revenue)}</p>
        <div className="flex gap-2 mt-1">{p.status === "DRAFT" && <button className={pb} onClick={() => act(p, "approve")}>Approve</button>}{p.status === "ACTIVE" && <button className={gb} onClick={() => act(p, "pause")}>Pause</button>}{p.status === "PAUSED" && <button className={gb} onClick={() => act(p, "resume")}>Resume</button>}{p.status !== "ENDED" && <button className={gb} onClick={() => act(p, "end")}>End</button>}</div></div>)}</div>
    <div className={`${card} text-sm space-y-2`}><H>New offer (draft)</H>
      <input aria-label="Offer name" className={f} placeholder="Name" value={x.name} onChange={(e) => setX({ ...x, name: e.target.value })} />
      <select aria-label="Offer type" className={f} value={x.type} onChange={(e) => setX({ ...x, type: e.target.value })}><option value="PERCENT">% off</option><option value="AMOUNT">Amount off</option><option value="BOGO">Buy X get Y</option></select>
      <div className="grid grid-cols-2 gap-2">{x.type === "BOGO" ? <><input aria-label="Buy" className={f} placeholder="Buy" value={x.buyQty} onChange={(e) => setX({ ...x, buyQty: e.target.value })} /><input aria-label="Get" className={f} placeholder="Get" value={x.getQty} onChange={(e) => setX({ ...x, getQty: e.target.value })} /></> : null}
        <input aria-label="Offer value" className={f} placeholder={x.type === "AMOUNT" ? "Amount" : "%"} value={x.value} onChange={(e) => setX({ ...x, value: e.target.value })} />
        <input aria-label="Coupon code" className={f} placeholder="Coupon code (optional)" value={x.code} onChange={(e) => setX({ ...x, code: e.target.value })} />
        <input aria-label="Categories" className={`${f} col-span-2`} placeholder="Categories, comma separated (empty = everything)" value={x.categories} onChange={(e) => setX({ ...x, categories: e.target.value })} />
        <input aria-label="Minimum spend" className={f} placeholder="Minimum spend" value={x.minSpend} onChange={(e) => setX({ ...x, minSpend: e.target.value })} />
        <select aria-label="Stacking" className={f} value={x.stacking} onChange={(e) => setX({ ...x, stacking: e.target.value })}><option value="EXCLUSIVE">doesn't combine</option><option value="STACKABLE">combines</option></select>
        <label className="col-span-2">Starts<input type="datetime-local" className={f} value={x.startsAt} onChange={(e) => setX({ ...x, startsAt: e.target.value })} /></label><label className="col-span-2">Ends<input type="datetime-local" className={f} value={x.endsAt} onChange={(e) => setX({ ...x, endsAt: e.target.value })} /></label>
        <input aria-label="Total uses" className={f} placeholder="Total uses (optional)" value={x.usageLimit} onChange={(e) => setX({ ...x, usageLimit: e.target.value })} /><input aria-label="Uses per customer" className={f} placeholder="Per customer (optional)" value={x.perCustomerLimit} onChange={(e) => setX({ ...x, perCustomerLimit: e.target.value })} /></div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={x.firstPurchaseOnly} onChange={(e) => setX({ ...x, firstPurchaseOnly: e.target.checked })} /> First purchase only</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={x.membersOnly} onChange={(e) => setX({ ...x, membersOnly: e.target.checked })} /> Members only</label>
      <button className={pb} onClick={() => a.run(async () => { await api("promotions", { orgId, method: "POST", body: { ...x, value: Number(x.value), buyQty: Number(x.buyQty), getQty: Number(x.getQty), categories: x.categories.split(",").map((c) => c.trim()).filter(Boolean), startsAt: x.startsAt ? new Date(x.startsAt).toISOString() : null, endsAt: x.endsAt ? new Date(x.endsAt).toISOString() : null, minSpend: x.minSpend || null } }); load(); }, "Draft saved: another manager approves it.")}>Save draft</button></div>
  </div>;
}

// ================================================================ Automation
const TRIGGER_NAMES = { FIRST_PURCHASE: "Welcome (first purchase)", POST_PURCHASE: "Review request (days after a purchase)", REPEAT_REMINDER: "Repeat reminder", REPLENISHMENT: "Replenishment reminder (product/category)", WIN_BACK: "Win-back (no purchase for N days)", BIRTHDAY: "Birthday", TIER_CHANGE: "Loyalty tier went up", MEMBERSHIP_EXPIRING: "Membership ending soon", ABANDONED_CART: "Abandoned cart (online store, Phase 5)" };
function Automation({ orgId }) {
  const [s, setS] = useState(null); const [trs, setTrs] = useState([]); const [seqs, setSeqs] = useState([]); const [x, setX] = useState({ type: "FIRST_PURCHASE", sequenceId: "", days: "" }); const [dry, setDry] = useState(null); const [attr, setAttr] = useState(null); const a = useAction();
  const load = useCallback(() => { api("automation/settings", { orgId }).then((d) => setS(d.settings)); api("triggers", { orgId }).then((d) => setTrs(d.triggers)).catch((e) => a.setErr(e.message)); api("attribution", { orgId }).then(setAttr).catch(() => {}); fetch(`/api/orgs/campaigns/sequences?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setSeqs(d.sequences || [])).catch(() => {}); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return <div className="grid gap-3 lg:grid-cols-2">
    <div className={`${card} text-sm space-y-2`}><H>Automatic emails</H>
      <p className={`text-xs ${mu}`}>A trigger puts people into an approved email sequence (Email Campaigns → Sequences). People are only included if they agreed to marketing and aren't unsubscribed, at most {s?.frequencyCapPer7Days ?? "–"} times a week, never during quiet hours.</p>
      {trs.map((t) => <p key={t.id}>{TRIGGER_NAMES[t.type] || t.type}{t.days ? ` · ${t.days} days` : ""} · {t.active ? "on" : "off"} · reached {t.fired}</p>)}
      <select aria-label="Trigger" className={f} value={x.type} onChange={(e) => setX({ ...x, type: e.target.value })}>{Object.entries(TRIGGER_NAMES).map(([k, v]) => <option key={k} value={k} disabled={k === "ABANDONED_CART"}>{v}</option>)}</select>
      <select aria-label="Sequence" className={f} value={x.sequenceId} onChange={(e) => setX({ ...x, sequenceId: e.target.value })}><option value="">Email sequence…</option>{seqs.map((q) => <option key={q.id} value={q.id}>{q.name} ({String(q.status || "").toLowerCase()})</option>)}</select>
      {["POST_PURCHASE", "REPEAT_REMINDER", "REPLENISHMENT", "WIN_BACK"].includes(x.type) && <input aria-label="Days" className={f} placeholder="After how many days" value={x.days} onChange={(e) => setX({ ...x, days: e.target.value })} />}
      <div className="flex gap-2"><button className={pb} onClick={() => a.run(async () => { await api("triggers", { orgId, method: "POST", body: { ...x, days: x.days ? Number(x.days) : undefined } }); load(); }, "Trigger saved.")}>Add trigger</button>
        <button className={gb} onClick={() => a.run(async () => setDry(await api("triggers/run", { orgId, method: "POST", body: { dryRun: true } })))}>Preview who it would reach</button></div>
      {dry && <div className={`text-xs ${mu}`}>{dry.quietHours ? "Quiet hours now: nothing would go out." : dry.triggers.map((t, i) => <p key={i}>{TRIGGER_NAMES[t.type]}: {t.wouldEnrol ?? 0} would be enrolled of {t.candidates}; skipped {t.skipped.noConsent} without consent, {t.skipped.suppressed} unsubscribed, {t.skipped.frequencyCap} over the weekly cap, {t.skipped.alreadyDone} already done.</p>)}</div>}
      <Msg ok={a.ok} err={a.err} /></div>
    <div className="space-y-3">
      {s && <div className={`${card} text-sm space-y-2`}><H>Safeguards</H>
        <label>Most automatic emails per person per week<input className={f} value={s.frequencyCapPer7Days} onChange={(e) => setS({ ...s, frequencyCapPer7Days: Number(e.target.value) })} /></label>
        <div className="grid grid-cols-2 gap-2"><label>Quiet from<input type="time" className={f} value={s.quietHours?.from || ""} onChange={(e) => setS({ ...s, quietHours: { ...(s.quietHours || {}), from: e.target.value } })} /></label><label>until<input type="time" className={f} value={s.quietHours?.to || ""} onChange={(e) => setS({ ...s, quietHours: { ...(s.quietHours || {}), to: e.target.value } })} /></label></div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.softOptInForCustomers} onChange={(e) => setS({ ...s, softOptInForCustomers: e.target.checked })} /> Existing customers may get service-style emails without a separate opt-in (only where your law allows "soft opt-in")</label>
        <p className={`text-xs ${mu}`}>Channels: email. SMS and WhatsApp need an approved provider and policy first.</p>
        <button className={pb} onClick={() => a.run(() => api("automation/settings", { orgId, method: "PUT", body: { frequencyCapPer7Days: s.frequencyCapPer7Days, quietHours: s.quietHours, softOptInForCustomers: s.softOptInForCustomers } }), "Saved.")}>Save safeguards</button></div>}
      {attr && <div className={`${card} text-sm`}><H>Sales after emails (last {attr.windowDays} days)</H><p>{money(attr.total)} in till sales followed an email click.</p><p className={`text-xs ${mu}`}>{attr.rule}</p></div>}
    </div>
  </div>;
}

// ================================================================ Duplicates
function Duplicates({ orgId }) {
  const [d, setD] = useState(null); const [merges, setMerges] = useState([]); const [pv, setPv] = useState(null); const a = useAction();
  const load = useCallback(() => { api("duplicates", { orgId }).then(setD).catch((e) => a.setErr(e.message)); api("merges", { orgId }).then((x) => setMerges(x.merges)).catch(() => {}); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return <div className="space-y-3">
    <div className={`${card} text-sm space-y-2`}><H>Possible duplicates</H><p className={`text-xs ${mu}`}>Matched on the same email or phone, or a very similar name together with the same company or address. Nothing is merged automatically.</p><Msg ok={a.ok} err={a.err} />
      {!d ? <p className={mu}>Checking…</p> : !d.candidates.length ? <p className={mu}>No likely duplicates.</p> : d.candidates.map((x, i) => <div key={i} className="border-t border-[var(--inaya-border)] py-2 flex flex-wrap items-center gap-2"><span className="flex-1">{x.a.name} ({x.a.email || x.a.phone || "–"}) ↔ {x.b.name} ({x.b.email || x.b.phone || "–"}) <span className={`text-xs ${mu}`}>{x.reasons.join(", ")} · {x.confidence.toLowerCase()}</span></span>
        <button className={gb} onClick={() => a.run(async () => setPv(await api("duplicates/preview", { orgId, method: "POST", body: { survivorId: x.a.id, duplicateId: x.b.id } })))}>Preview merge</button></div>)}</div>
    {pv && <div className={`${card} text-sm space-y-1`}><H>Merge preview</H><p>Keep <b>{pv.survivor.name}</b>; fold in <b>{pv.duplicate.name}</b>.</p><p className={mu}>Moves: {Object.entries(pv.moves).filter(([, v]) => v).map(([k, v]) => `${v} ${k.replace(/^g_|^c_/, "").replaceAll("_", " ")}`).join(", ") || "nothing"}{Object.keys(pv.fillsEmptyFields).length ? ` · fills: ${Object.keys(pv.fillsEmptyFields).join(", ")}` : ""}</p><p className={`text-xs ${mu}`}>{pv.note}</p>
      <div className="flex gap-2"><button className={pb} onClick={() => { const reason = window.prompt("Why merge? (kept in the history)"); if (reason) a.run(async () => { await api("duplicates/merge", { orgId, method: "POST", body: { survivorId: pv.survivor.id, duplicateId: pv.duplicate.id, reason } }); setPv(null); load(); }, "Merged. You can undo it below."); }}>Merge</button><button className={gb} onClick={() => setPv(null)}>Cancel</button></div></div>}
    {merges.length > 0 && <div className={`${card} text-sm`}><H>Merge history</H>{merges.map((m) => <p key={m.id}>{new Date(m.at).toLocaleString()} · {m.by} · {m.reason || ""} {m.undone ? <span className={mu}>(undone)</span> : <button className={`${gb} ml-2`} onClick={() => a.run(async () => { await api(`merges/${m.id}/undo`, { orgId, method: "POST", body: {} }); load(); }, "Merge undone.")}>Undo</button>}</p>)}</div>}
  </div>;
}

// ================================================================ Assistant
function Assistant({ orgId }) {
  const [risk, setRisk] = useState(null); const [pat, setPat] = useState(null); const [goal, setGoal] = useState(""); const [draft, setDraft] = useState(null); const a = useAction();
  useEffect(() => { api("assistant/at-risk", { orgId }).then(setRisk).catch((e) => a.setErr(e.message)); api("assistant/patterns", { orgId }).then(setPat).catch(() => {}); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="grid gap-3 lg:grid-cols-2">
    <div className={`${card} text-sm space-y-1`}><H>Customers at risk</H><p className={`text-xs ${mu}`}>{risk?.rule}</p>{!risk ? <p className={mu}>…</p> : !risk.customers.length ? <p className={mu}>Nobody looks at risk right now.</p> : risk.customers.map((c) => <p key={c.customerId}>{c.name} · {money(c.spend)} spent · {c.why} <span className={mu}>{c.suggestion}</span></p>)}</div>
    <div className={`${card} text-sm space-y-1`}><H>Worth a look</H>{pat ? <>{pat.customers.map((x) => <p key={x.customerId}>Customer {x.customerId.slice(-6)}: {x.note} ({x.refundRate}%)</p>)}{pat.staff.map((x) => <p key={x.staff}>{x.staff}: {x.note} ({x.refunds}, {money(x.value)})</p>)}{pat.pointsAdjustments.map((x) => <p key={x.by}>{x.by}: {x.note} ({x.points} points)</p>)}{!pat.customers.length && !pat.staff.length && !pat.pointsAdjustments.length && <p className={mu}>Nothing unusual.</p>}<p className={`text-xs ${mu}`}>{pat.disclaimer}</p></> : <p className={mu}>Managers only.</p>}</div>
    <div className={`${card} text-sm space-y-2 lg:col-span-2`}><H>Draft a campaign</H><p className={`text-xs ${mu}`}>The assistant only drafts. You check every claim, paste it into a campaign and send it through the normal approval.</p>
      <input aria-label="Campaign goal" className={f} placeholder="e.g. invite last month's tea buyers to try the new green teas" value={goal} onChange={(e) => setGoal(e.target.value)} />
      <button className={pb} disabled={goal.trim().length < 5} onClick={() => a.run(async () => setDraft((await api("assistant/draft", { orgId, method: "POST", body: { goal } })).draft))}>Draft</button><Msg ok={a.ok} err={a.err} />
      {draft && <div className="border border-[var(--inaya-border)] rounded-lg p-2"><p className="font-semibold">{draft.subject}</p>{draft.preheader && <p className={`text-xs ${mu}`}>{draft.preheader}</p>}<p className="whitespace-pre-wrap mt-1">{draft.body}</p>{draft.notes?.length > 0 && <p className={`text-xs ${mu} mt-1`}>Check: {draft.notes.join("; ")}</p>}</div>}</div>
  </div>;
}
