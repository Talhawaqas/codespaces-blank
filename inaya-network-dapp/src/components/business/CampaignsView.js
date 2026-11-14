"use client";

// src/components/business/CampaignsView.js
//
// Mass Marketing Email (Business Workspace, Business and Enterprise plans).
// Overview (open/click/bounce rates vs targets, monthly allowance, approvals
// waiting), Campaigns (4-step builder: Design -> Audience -> Review -> Send,
// plus per-campaign reports), Sequences (automated follow-ups), Segments,
// Unsubscribes (suppression list) and Settings (sender, postal address,
// approval, roles). Permissions are enforced server-side (src/lib/engagement/*).

import { useState, useEffect, useCallback } from "react";
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
const label = (s) => String(s || "").replace(/_/g, " ").toLowerCase();
const fmt = (d) => (d ? new Date(d).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const STATUS_STYLE = { DRAFT: "text-[var(--inaya-text-muted)] bg-white/5", PENDING_APPROVAL: "text-amber-300 bg-amber-400/10", SCHEDULED: "text-[#00f2fe] bg-[#00f2fe]/10", SENDING: "text-[#00f2fe] bg-[#00f2fe]/10", SENT: "text-emerald-300 bg-emerald-400/10", CANCELLED: "text-red-300 bg-red-400/10", ACTIVE: "text-emerald-300 bg-emerald-400/10", PAUSED: "text-amber-300 bg-amber-400/10" };
const Badge = ({ status }) => <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${STATUS_STYLE[status] || ""}`}>{label(status)}</span>;

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setData(await fn()); } catch (err) { setError(err.message); if (err.data?.upgrade) setData({ upgrade: true }); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return [data, load, error];
}

export default function CampaignsView({ orgId, canManage }) {
  const TABS = [["overview", "Overview"], ["campaigns", "Campaigns"], ["sequences", "Follow-up sequences"], ["segments", "Segments"], ["suppressions", "Unsubscribes"], ["settings", "Settings"]];
  const [tab, setTab] = useErpSection("overview", TABS);
  const [options, reloadOptions, optErr] = useLoad(() => api(`/api/orgs/campaigns/options?orgId=${orgId}`), [orgId]);
  const [openId, setOpenId] = useState(() => { try { return new URLSearchParams(window.location.search).get("campaign"); } catch { return null; } });
  if (options?.upgrade || /Business and Enterprise/.test(optErr || "")) return <EmptyState title="Email campaigns are part of Business and Enterprise" description="Newsletters, offers, re-engagement and event invitations to your CRM contacts, with approvals, scheduling and open/click reports. Upgrade in Settings → Billing." />;
  if (!options) return <p className={muted}>{optErr || "Loading…"}</p>;
  if (!options.can.view) return <EmptyState title="You don't have a marketing role" description="Ask the owner or an admin to make you a marketing editor, approver or manager (Email campaigns → Settings → Roles)." />;
  const ctx = { orgId, options, reloadOptions, openCampaign: (id) => { setOpenId(id); setTab("campaigns"); } };
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap" data-erp-tabs>
        {TABS.map(([key, text]) => <button key={key} onClick={() => { setTab(key); if (key !== "campaigns") setOpenId(null); }} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{text}</button>)}
      </div>
      {!options.sender.configured && <p className={`${panel} text-amber-300 text-sm`}>{options.sender.message} You can build and approve campaigns now; nothing sends until it&apos;s connected.</p>}
      {tab === "overview" && <Overview {...ctx} />}
      {tab === "campaigns" && (openId ? <Builder {...ctx} id={openId} onClose={() => setOpenId(null)} /> : <CampaignList {...ctx} onOpen={setOpenId} />)}
      {tab === "sequences" && <Sequences {...ctx} />}
      {tab === "segments" && <Segments {...ctx} />}
      {tab === "suppressions" && <Suppressions {...ctx} />}
      {tab === "settings" && <Settings {...ctx} canManageOrg={canManage} />}
    </div>
  );
}

function Overview({ orgId, options, openCampaign }) {
  const [days, setDays] = useState(30);
  const [data, , err] = useLoad(() => api(`/api/orgs/campaigns/overview?orgId=${orgId}&days=${days}`), [orgId, days]);
  const [pending] = useLoad(() => api(`/api/orgs/campaigns/campaigns?orgId=${orgId}&status=PENDING_APPROVAL`), [orgId]);
  const cards = data ? [
    ["Open rate", pct(data.rates.open), `target ${data.targets.open}%`, data.rates.open !== null && data.rates.open >= data.targets.open],
    ["Click-through rate", pct(data.rates.click), `target ${data.targets.click}%`, data.rates.click !== null && data.rates.click >= data.targets.click],
    ["Bounce rate", pct(data.rates.bounce), "keep under 2%", data.rates.bounce !== null && data.rates.bounce < 2],
    ["Emails sent", data.totals.sent.toLocaleString(), `${data.campaigns} campaigns`, null],
  ] : [];
  return (
    <div className="space-y-4">
      <select className={input} value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(([t, v, sub, good]) => <div key={t} className={panel}><p className={muted}>{t}</p><p className="text-2xl font-bold text-[var(--inaya-text-primary)] mt-2">{v}</p><p className={`text-[11px] ${good === true ? "text-emerald-300" : good === false ? "text-amber-300" : "text-[var(--inaya-text-muted)]"}`}>{sub}</p></div>)}
      </div>
      {data && (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className={panel}><h3 className={h3}>This month&apos;s allowance</h3><p className="text-sm text-[var(--inaya-text-primary)]">{data.usage.used.toLocaleString()} of {data.usage.limit.toLocaleString()} emails used</p><div className="h-2 bg-white/5 rounded mt-2"><div className="h-2 rounded bg-[#00f2fe]" style={{ width: `${Math.min(100, (data.usage.used / Math.max(1, data.usage.limit)) * 100)}%` }} /></div><p className={`${muted} mt-2`}>Resets on {new Date(data.usage.resetsAt).toLocaleDateString([], { day: "numeric", month: "long", timeZone: "UTC" })}</p></div>
          <div className={panel}><h3 className={h3}>Waiting for approval</h3>{(pending?.campaigns || []).length === 0 ? <p className={muted}>Nothing waiting.</p> : pending.campaigns.map((c) => <button key={c.id} className={`${row} w-full mb-1 text-left`} onClick={() => openCampaign(c.id)}><span className="text-sm text-[var(--inaya-text-primary)] truncate">{c.name}</span><span className={muted}>{c.approval?.requestedBy}</span></button>)}{options.can.approve && pending?.campaigns?.length > 0 && <p className={`${muted} mt-1`}>Open one to approve or request changes.</p>}</div>
          <div className={panel}><h3 className={h3}>Audience health</h3><p className="text-sm text-[var(--inaya-text-primary)]">{data.suppressed.toLocaleString()} addresses on the do-not-email list</p><p className={muted}>{data.totals.unsubscribed} unsubscribes · {data.totals.complained} spam reports · {data.totals.bounced} bounces in this period</p><p className={`${muted} mt-2`}>{data.scheduled} campaigns scheduled</p></div>
        </div>
      )}
    </div>
  );
}

function CampaignList({ orgId, options, onOpen }) {
  const [data, , err] = useLoad(() => api(`/api/orgs/campaigns/campaigns?orgId=${orgId}`), [orgId]);
  const [tpls] = useLoad(() => api(`/api/orgs/campaigns/templates?orgId=${orgId}`), [orgId]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("starter:newsletter");
  const [msg, setMsg] = useState("");
  const create = async () => { setMsg(""); try { const r = await api(`/api/orgs/campaigns/campaigns`, { method: "POST", body: JSON.stringify({ orgId, name, templateId }) }); onOpen(r.campaign.id); } catch (e) { setMsg(e.message); } };
  return (
    <div className={panel}>
      <div className="flex justify-between mb-3"><h3 className={h3n}>Campaigns</h3>{options.can.edit && <button className={primary} onClick={() => setCreating((v) => !v)}>New campaign</button>}</div>
      {creating && (
        <div className={`${row} flex-col items-stretch mb-3`}>
          <input className={input} placeholder="Campaign name (for you, not the subject line)" value={name} onChange={(e) => setName(e.target.value)} />
          <p className={muted}>Start from</p>
          <div className="grid sm:grid-cols-3 gap-2">{(tpls?.templates || []).map((t) => <button key={t.id} onClick={() => setTemplateId(t.id)} className={`text-left p-2 rounded-lg border ${templateId === t.id ? "border-[#00f2fe] bg-[#00f2fe]/10" : "border-white/10"}`}><p className="text-sm text-[var(--inaya-text-primary)]">{t.name}</p><p className={muted}>{tpls.useCases[t.useCase] || t.useCase}{t.starter ? "" : " · saved template"}</p></button>)}</div>
          <button className={primary} disabled={!name} onClick={create}>Create and design</button>
          {msg && <p className="text-red-300 text-sm">{msg}</p>}
        </div>
      )}
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {data?.campaigns?.length === 0 && !creating && <p className={muted}>No campaigns yet.</p>}
      <div className="space-y-2">{(data?.campaigns || []).map((c) => (
        <button key={c.id} onClick={() => onOpen(c.id)} className={`${row} w-full text-left`}>
          <div className="min-w-0"><p className="text-sm text-[var(--inaya-text-primary)] truncate">{c.name} <span className={muted}>· {c.subject || "no subject yet"}</span></p><p className={muted}>{c.schedule?.recurrence ? `Repeats ${c.schedule.recurrence.freq} · ` : ""}{c.status === "SCHEDULED" ? `Sends ${fmt(c.nextRunAt)}` : `Updated ${fmt(c.updatedAt)}`}{c.stats.sent ? ` · ${c.stats.sent.toLocaleString()} sent · open ${pct(c.rates.open)} · click ${pct(c.rates.click)}` : ""}</p>{c.lastError && <p className="text-amber-300 text-xs">{c.lastError}</p>}</div>
          <Badge status={c.status} />
        </button>
      ))}</div>
    </div>
  );
}

// ------------------------------------------------------------------ builder

const STEPS = [["design", "Design"], ["audience", "Audience"], ["review", "Review"], ["send", "Send"]];

function Builder({ orgId, options, id, onClose }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/campaigns/campaigns/${id}?orgId=${orgId}`), [orgId, id]);
  const [step, setStep] = useState("design");
  const [msg, setMsg] = useState("");
  const c = data?.campaign;
  useEffect(() => { if (c && ["SENDING", "SENT", "CANCELLED"].includes(c.status)) setStep("report"); else if (c?.status === "PENDING_APPROVAL" || c?.status === "SCHEDULED") setStep("send"); }, [c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = async (updates, ok = "Saved.") => { setMsg(""); try { const r = await api(`/api/orgs/campaigns/campaigns/${id}`, { method: "PATCH", body: JSON.stringify({ orgId, ...updates }) }); setMsg(r.returnedToDraft ? "Saved. Because it changed, it's back to draft and needs approval again." : ok); await reload(); return true; } catch (e) { setMsg(e.message); return false; } };
  const action = async (path, body = {}, ok) => { setMsg(""); try { await api(`/api/orgs/campaigns/campaigns/${id}/${path}`, { method: "POST", body: JSON.stringify({ orgId, ...body }) }); setMsg(ok); await reload(); } catch (e) { setMsg(e.message); } };
  if (!c) return <p className={muted}>{err || "Loading…"}</p>;
  const editable = ["DRAFT", "PENDING_APPROVAL", "SCHEDULED"].includes(c.status) && options.can.edit;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2"><button className={ghost} onClick={onClose}>‹ All campaigns</button><h2 className="text-lg font-semibold text-[var(--inaya-text-primary)]">{c.name}</h2><Badge status={c.status} /></div>
      <div className="flex flex-wrap gap-1">
        {STEPS.map(([k, t], i) => <button key={k} onClick={() => setStep(k)} className={`px-3 py-1.5 text-xs font-bold uppercase rounded-lg border ${step === k ? "border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{i + 1}. {t}</button>)}
        {c.stats.recipients > 0 && <button onClick={() => setStep("report")} className={`px-3 py-1.5 text-xs font-bold uppercase rounded-lg border ${step === "report" ? "border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>Report</button>}
      </div>
      {msg && <p className="text-sm text-[var(--inaya-text-primary)]">{msg}</p>}
      {step === "design" && <DesignStep orgId={orgId} options={options} c={c} editable={editable} save={patch} next={() => setStep("audience")} />}
      {step === "audience" && <AudienceStep orgId={orgId} c={c} editable={editable} save={patch} next={() => setStep("review")} />}
      {step === "review" && <ReviewStep orgId={orgId} id={id} options={options} action={action} next={() => setStep("send")} />}
      {step === "send" && <SendStep orgId={orgId} c={c} options={options} editable={editable} save={patch} action={action} />}
      {step === "report" && <Report orgId={orgId} id={id} c={c} options={options} action={action} />}
    </div>
  );
}

function BlockEditor({ blocks, setBlocks, disabled }) {
  const upd = (i, v) => setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...v } : b)));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= blocks.length) return; const x = [...blocks]; [x[i], x[j]] = [x[j], x[i]]; setBlocks(x); };
  const ADD = { heading: { type: "heading", level: 1, text: "Heading" }, text: { type: "text", text: "Write something…" }, button: { type: "button", label: "Learn more", url: "https://" }, image: { type: "image", src: "https://", alt: "" }, columns: { type: "columns", left: "", right: "" }, divider: { type: "divider" }, spacer: { type: "spacer", height: 16 } };
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => (
        <div key={i} className="border border-white/10 rounded-lg p-2 space-y-1">
          <div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{b.type}</span>{!disabled && <span className="flex gap-1"><button className={ghost} onClick={() => move(i, -1)}>↑</button><button className={ghost} onClick={() => move(i, 1)}>↓</button><button className={ghost} onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}>×</button></span>}</div>
          {b.type === "heading" && <input disabled={disabled} className={`${input} w-full font-semibold`} value={b.text} onChange={(e) => upd(i, { text: e.target.value })} />}
          {b.type === "text" && <textarea disabled={disabled} className={`${input} w-full`} rows={4} value={b.text} onChange={(e) => upd(i, { text: e.target.value })} />}
          {b.type === "button" && <div className="flex gap-2"><input disabled={disabled} className={`${input} w-1/3`} placeholder="Label" value={b.label} onChange={(e) => upd(i, { label: e.target.value })} /><input disabled={disabled} className={`${input} flex-1`} placeholder="https://… or {{booking_url}}" value={b.url} onChange={(e) => upd(i, { url: e.target.value })} /></div>}
          {b.type === "image" && <div className="flex gap-2"><input disabled={disabled} className={`${input} flex-1`} placeholder="Image https:// address" value={b.src} onChange={(e) => upd(i, { src: e.target.value })} /><input disabled={disabled} className={`${input} w-1/3`} placeholder="Description" value={b.alt} onChange={(e) => upd(i, { alt: e.target.value })} /></div>}
          {b.type === "columns" && <div className="flex gap-2"><textarea disabled={disabled} className={`${input} flex-1`} rows={3} value={b.left} onChange={(e) => upd(i, { left: e.target.value })} /><textarea disabled={disabled} className={`${input} flex-1`} rows={3} value={b.right} onChange={(e) => upd(i, { right: e.target.value })} /></div>}
        </div>
      ))}
      {!disabled && <div className="flex flex-wrap gap-1">{Object.keys(ADD).map((k) => <button key={k} className={ghost} onClick={() => setBlocks([...blocks, { ...ADD[k] }])}>+ {k}</button>)}</div>}
      <p className={muted}>Text formatting: **bold**, *italic*, [link text](https://…). A blank line starts a new paragraph.</p>
    </div>
  );
}

function DesignStep({ orgId, options, c, editable, save, next }) {
  const [subject, setSubject] = useState(c.subject || "");
  const [preheader, setPreheader] = useState(c.preheader || "");
  const [blocks, setBlocks] = useState(c.blocks || []);
  const [useCase, setUseCase] = useState(c.useCase || "other");
  const [tplName, setTplName] = useState("");
  const [tplMsg, setTplMsg] = useState("");
  const saveTemplate = async () => { setTplMsg(""); try { await api(`/api/orgs/campaigns/templates`, { method: "POST", body: JSON.stringify({ orgId, name: tplName, useCase, subject, preheader, blocks }) }); setTplMsg("Saved as a template."); setTplName(""); } catch (e) { setTplMsg(e.message); } };
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className={`${panel} lg:col-span-2 space-y-3`}>
        <label className="block space-y-1"><span className={muted}>Subject line</span><input disabled={!editable} className={`${input} w-full`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. {{first_name|Hi}}, what's new this month" /></label>
        <label className="block space-y-1"><span className={muted}>Preview text (shown after the subject in the inbox)</span><input disabled={!editable} className={`${input} w-full`} value={preheader} onChange={(e) => setPreheader(e.target.value)} /></label>
        <label className="block space-y-1"><span className={muted}>Type</span><select disabled={!editable} className={`${input} w-full`} value={useCase} onChange={(e) => setUseCase(e.target.value)}>{Object.entries(options.useCases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <BlockEditor blocks={blocks} setBlocks={setBlocks} disabled={!editable} />
        {editable && <div className="flex gap-2"><button className={primary} onClick={async () => { if (await save({ subject, preheader, blocks, useCase })) next(); }}>Save and continue</button><button className={ghost} onClick={() => save({ subject, preheader, blocks, useCase })}>Save</button></div>}
      </div>
      <div className="space-y-4">
        <div className={panel}><h3 className={h3}>Personalise</h3>{Object.entries(options.mergeFields).map(([k, v]) => <p key={k} className="text-xs text-[var(--inaya-text-primary)]"><code className="text-[#00f2fe]">{`{{${k}}}`}</code> <span className={muted}>{v}</span></p>)}<p className={`${muted} mt-2`}>Add a fallback after a bar: <code>{"{{first_name|there}}"}</code>. The unsubscribe link and your postal address are added to every email automatically.</p></div>
        {options.can.edit && <div className={panel}><h3 className={h3}>Save as template</h3><input className={`${input} w-full`} placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} /><button className={`${ghost} mt-2`} disabled={!tplName} onClick={saveTemplate}>Save template</button>{tplMsg && <p className={muted}>{tplMsg}</p>}</div>}
      </div>
    </div>
  );
}

const RULE_DEFAULT = { contactTypes: [], departmentIds: [], companyContains: "", emailDomain: "", createdWithinDays: "", inactiveDays: "", appointment: "", consentedOnly: false };

function RulesForm({ rules, setRules, departments, disabled }) {
  const r = { ...RULE_DEFAULT, ...rules };
  const set = (k, v) => setRules({ ...r, [k]: v });
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <label className="space-y-1"><span className={muted}>Contacts</span><select disabled={disabled} className={`${input} w-full`} value={r.contactTypes.length === 1 ? r.contactTypes[0] : ""} onChange={(e) => set("contactTypes", e.target.value ? [e.target.value] : [])}><option value="">Leads and customers</option><option value="LEAD">Leads only</option><option value="CUSTOMER">Customers only</option></select></label>
      <label className="space-y-1"><span className={muted}>Department</span><select disabled={disabled} className={`${input} w-full`} value={r.departmentIds[0] || ""} onChange={(e) => set("departmentIds", e.target.value ? [e.target.value] : [])}><option value="">All departments</option>{(departments || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label className="space-y-1"><span className={muted}>Inactive for (days) — re-engagement</span><input disabled={disabled} type="number" className={`${input} w-full`} value={r.inactiveDays} onChange={(e) => set("inactiveDays", e.target.value ? Number(e.target.value) : "")} /></label>
      <label className="space-y-1"><span className={muted}>Added in the last (days)</span><input disabled={disabled} type="number" className={`${input} w-full`} value={r.createdWithinDays} onChange={(e) => set("createdWithinDays", e.target.value ? Number(e.target.value) : "")} /></label>
      <label className="space-y-1"><span className={muted}>Appointments</span><select disabled={disabled} className={`${input} w-full`} value={r.appointment} onChange={(e) => set("appointment", e.target.value)}><option value="">Any</option><option value="booked_any">Have booked before</option><option value="never_booked">Never booked</option><option value="completed_recently">Had a meeting in the last 30 days</option></select></label>
      <label className="space-y-1"><span className={muted}>Company contains</span><input disabled={disabled} className={`${input} w-full`} value={r.companyContains} onChange={(e) => set("companyContains", e.target.value)} /></label>
      <label className="space-y-1"><span className={muted}>Email domain</span><input disabled={disabled} className={`${input} w-full`} placeholder="example.com" value={r.emailDomain} onChange={(e) => set("emailDomain", e.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)] mt-5"><input disabled={disabled} type="checkbox" checked={r.consentedOnly} onChange={(e) => set("consentedOnly", e.target.checked)} /> Only people who opted in</label>
    </div>
  );
}

const cleanRules = (r) => Object.fromEntries(Object.entries({ ...RULE_DEFAULT, ...r }).filter(([, v]) => !(v === "" || v === false || (Array.isArray(v) && !v.length))));

function AudienceStep({ orgId, c, editable, save, next }) {
  const [segs] = useLoad(() => api(`/api/orgs/campaigns/segments?orgId=${orgId}`), [orgId]);
  const [depts] = useLoad(() => api(`/api/orgs/departments?orgId=${orgId}`).catch(() => ({ departments: [] })), [orgId]);
  const [segmentId, setSegmentId] = useState(c.audience?.segmentId || "");
  const [rules, setRules] = useState(c.audience?.rules || {});
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState("");
  const run = async () => { setErr(""); try { setPreview(await api(`/api/orgs/campaigns/audience/preview`, { method: "POST", body: JSON.stringify({ orgId, ...(segmentId ? { segmentId } : { rules: cleanRules(rules) }) }) })); } catch (e) { setErr(e.message); } };
  useEffect(() => { run(); }, [segmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`${panel} space-y-3`}>
      <label className="block space-y-1"><span className={muted}>Saved segment</span><select disabled={!editable} className={`${input} w-full`} value={segmentId} onChange={(e) => setSegmentId(e.target.value)}><option value="">Build it here</option>{(segs?.segments || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      {!segmentId && <RulesForm rules={rules} setRules={setRules} departments={depts?.departments} disabled={!editable} />}
      <div className="flex gap-2"><button className={ghost} onClick={run}>Count recipients</button>{editable && <button className={primary} onClick={async () => { if (await save({ audience: segmentId ? { segmentId } : { rules: cleanRules(rules) } })) next(); }}>Save and continue</button>}</div>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {preview && <div className={`${row} flex-col items-stretch`}><p className="text-sm text-[var(--inaya-text-primary)]"><strong>{preview.count.toLocaleString()}</strong> recipients. {preview.description}</p>{preview.sample.length > 0 && <p className={muted}>For example: {preview.sample.map((s) => s.name || s.email).join(", ")}</p>}</div>}
    </div>
  );
}

function ReviewStep({ orgId, id, options, action, next }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/campaigns/campaigns/${id}/review?orgId=${orgId}`), [orgId, id]);
  const [testTo, setTestTo] = useState(options.me || "");
  const [testMsg, setTestMsg] = useState("");
  const test = async () => { setTestMsg(""); try { const r = await api(`/api/orgs/campaigns/campaigns/${id}/test`, { method: "POST", body: JSON.stringify({ orgId, to: testTo.split(/[,\s]+/).filter(Boolean) }) }); setTestMsg(r.results.map((x) => `${x.to}: ${x.sent ? "sent" : `not sent (${x.reason})`}`).join(" · ")); } catch (e) { setTestMsg(e.message); } };
  if (!data) return <p className={muted}>{err || "Checking…"}</p>;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className={`${panel} space-y-3`}>
        <h3 className={h3}>Checklist</h3>
        {data.ready ? <p className="text-emerald-300 text-sm">✓ Ready to {data.requireApproval ? "submit for approval" : "schedule"}.</p> : data.issues.map((x) => <p key={x} className="text-amber-300 text-sm">• {x}</p>)}
        <p className="text-sm text-[var(--inaya-text-primary)]">Subject: <strong>{data.preview.subject || "—"}</strong></p>
        <p className="text-sm text-[var(--inaya-text-primary)]">Recipients: <strong>{data.audienceCount.toLocaleString()}</strong> <span className={muted}>({data.suppressedCount} left out: unsubscribed, bounced or complained)</span></p>
        <p className={muted}>Allowance: {data.usage.remaining.toLocaleString()} of {data.usage.limit.toLocaleString()} left this month.</p>
        <div className="border-t border-white/5 pt-3"><p className={h3}>Send a test</p><div className="flex gap-2"><input className={`${input} flex-1`} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="team member emails" /><button className={ghost} onClick={test}>Send test</button></div>{testMsg && <p className={`${muted} mt-1`}>{testMsg}</p>}<p className={`${muted} mt-1`}>Tests go to company members only and use sample personalisation.</p></div>
        <div className="flex gap-2"><button className={ghost} onClick={reload}>Re-check</button><button className={primary} disabled={!data.ready} onClick={next}>Continue to send</button></div>
      </div>
      <div className={panel}><h3 className={h3}>Preview (sample recipient)</h3><iframe title="Email preview" sandbox="" className="w-full h-[560px] rounded-lg bg-white" srcDoc={data.preview.html} /></div>
    </div>
  );
}

function SendStep({ orgId, c, options, editable, save, action }) {
  const [when, setWhen] = useState(c.schedule?.sendAt ? "later" : "now");
  const [sendAt, setSendAt] = useState(() => (c.schedule?.sendAt ? new Date(c.schedule.sendAt).toISOString().slice(0, 16) : ""));
  const [repeat, setRepeat] = useState(c.schedule?.recurrence?.freq || "");
  const [interval, setInterval] = useState(c.schedule?.recurrence?.interval || 1);
  const [maxRuns, setMaxRuns] = useState(c.schedule?.recurrence?.maxRuns || 4);
  const [note, setNote] = useState("");
  const [seqs] = useLoad(() => api(`/api/orgs/campaigns/sequences?orgId=${orgId}`).catch(() => ({ sequences: [] })), [orgId]);
  const [followUp, setFollowUp] = useState(c.followUpSequenceId || "");
  const scheduleBody = { sendAt: when === "later" && sendAt ? new Date(sendAt).toISOString() : null, recurrence: repeat ? { freq: repeat, interval: Number(interval), maxRuns: Number(maxRuns) } : null };
  const mine = c.approval?.requestedBy && options.me && c.approval.requestedBy.toLowerCase() === options.me.toLowerCase();
  return (
    <div className={`${panel} space-y-4`}>
      {c.status === "DRAFT" && editable && <>
        <h3 className={h3}>When should it go out?</h3>
        <div className="flex flex-wrap gap-4 text-sm text-[var(--inaya-text-primary)]"><label className="flex items-center gap-1"><input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> As soon as it&apos;s approved</label><label className="flex items-center gap-1"><input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /> At a set time</label></div>
        {when === "later" && <input type="datetime-local" className={input} value={sendAt} onChange={(e) => setSendAt(e.target.value)} />}
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--inaya-text-primary)]">Repeat <select className={input} value={repeat} onChange={(e) => setRepeat(e.target.value)}><option value="">No</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>{repeat && <>every <input type="number" min={1} max={12} className={`${input} w-16`} value={interval} onChange={(e) => setInterval(e.target.value)} /> for <input type="number" min={1} max={365} className={`${input} w-20`} value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} /> sends</>}</div>
        {repeat && <p className={muted}>Each repeat goes to the segment as it is then (new contacts included, unsubscribes left out).</p>}
        <label className="flex flex-wrap items-center gap-2 text-sm text-[var(--inaya-text-primary)]">Afterwards, add recipients to <select className={input} value={followUp} onChange={(e) => setFollowUp(e.target.value)}><option value="">no follow-up sequence</option>{(seqs?.sequences || []).map((q) => <option key={q.id} value={q.id}>{q.name} ({label(q.status)})</option>)}</select></label>
        <button className={primary} onClick={async () => { if (await save({ schedule: scheduleBody, followUpSequenceId: followUp || null }, "Schedule saved.")) await action("submit", {}, "Submitted."); }}>Save and submit</button>
      </>}
      {c.status === "PENDING_APPROVAL" && <>
        <p className="text-sm text-[var(--inaya-text-primary)]">Waiting for approval. Submitted by {c.approval?.requestedBy} {fmt(c.approval?.requestedAt)}.</p>
        {options.can.approve && !mine && <div className="space-y-2"><textarea className={`${input} w-full`} rows={2} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} /><div className="flex gap-2"><button className={primary} onClick={() => action("approve", { note }, "Approved and scheduled.")}>Approve</button><button className={ghost} onClick={() => action("reject", { note }, "Sent back with your note.")}>Request changes</button></div></div>}
        {mine && <p className={muted}>Someone else with the approver or manager role must approve it.</p>}
      </>}
      {c.status === "DRAFT" && c.approval?.approved === false && <p className="text-amber-300 text-sm">Changes requested by {c.approval.decidedBy}: {c.approval.note || "no note"}</p>}
      {c.status === "SCHEDULED" && <p className="text-sm text-[var(--inaya-text-primary)]">Scheduled for {fmt(c.nextRunAt)}{c.schedule?.recurrence ? `, repeating ${c.schedule.recurrence.freq} (${c.schedule.recurrence.runsDone || 0} of ${c.schedule.recurrence.maxRuns || "∞"} done)` : ""}. Approved by {c.approval?.decidedBy}.</p>}
      {["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "SENDING"].includes(c.status) && (options.can.edit || options.can.approve) && <button className={ghost} onClick={() => { if (window.confirm("Cancel this campaign? Anything not yet sent will not go out.")) action("cancel", {}, "Cancelled."); }}>Cancel campaign</button>}
      {c.lastError && <p className="text-amber-300 text-sm">{c.lastError}</p>}
    </div>
  );
}

function Report({ orgId, id, c, options, action }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/campaigns/campaigns/${id}/report?orgId=${orgId}`), [orgId, id]);
  useEffect(() => { if (c.status !== "SENDING") return; const t = setInterval(reload, 30000); return () => clearInterval(t); }, [c.status, reload]);
  if (!data) return <p className={muted}>{err || "Loading…"}</p>;
  const s = data.campaign.stats; const r = data.campaign.rates;
  const tiles = [["Recipients", s.recipients], ["Sent", s.sent], ["Delivered", s.delivered], ["Opened", `${s.opened} (${pct(r.open)})`], ["Clicked", `${s.clicked} (${pct(r.click)})`], ["Bounced", `${s.bounced} (${pct(r.bounce)})`], ["Unsubscribed", s.unsubscribed], ["Spam reports", s.complained]];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{tiles.map(([t, v]) => <div key={t} className={panel}><p className={muted}>{t}</p><p className="text-xl font-bold text-[var(--inaya-text-primary)] mt-1">{typeof v === "number" ? v.toLocaleString() : v}</p></div>)}</div>
      <div className="grid lg:grid-cols-2 gap-4">
        <div className={panel}><h3 className={h3}>Top links</h3>{data.links.length === 0 ? <p className={muted}>No clicks yet.</p> : data.links.map((l) => <div key={l.url} className={`${row} mb-1`}><span className="text-xs text-[var(--inaya-text-primary)] truncate">{l.url}</span><span className={muted}>{l.unique} people · {l.clicks} clicks</span></div>)}</div>
        <div className={panel}><h3 className={h3}>Opens by hour</h3>{data.timeline.opens.length === 0 ? <p className={muted}>No opens yet.</p> : <div className="flex items-end gap-0.5 h-32">{data.timeline.opens.slice(-48).map((x) => { const max = Math.max(...data.timeline.opens.map((y) => y.n)); return <div key={x.hour} title={`${fmt(x.hour)}: ${x.n}`} className="flex-1 bg-[#00f2fe]/60 rounded-t" style={{ height: `${(x.n / max) * 100}%` }} />; })}</div>}<p className={`${muted} mt-2`}>{data.note}</p></div>
      </div>
      {options.can.edit && <button className={ghost} onClick={() => action("duplicate", {}, "Copied to a new draft (see the campaign list).")}>Duplicate as new draft</button>}
    </div>
  );
}

// ------------------------------------------------------------- sequences

function Sequences({ orgId, options }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/campaigns/sequences?orgId=${orgId}`), [orgId]);
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState("");
  const [enroll, setEnroll] = useState({});
  const act = async (sid, path, body = {}, ok) => { setMsg(""); try { await api(`/api/orgs/campaigns/sequences/${sid}/${path}`, { method: "POST", body: JSON.stringify({ orgId, ...body }) }); setMsg(ok); reload(); } catch (e) { setMsg(e.message); } };
  const save = async () => { setMsg(""); try { const body = { orgId, name: edit.name, steps: edit.steps.map((s) => ({ ...s, delayHours: Number(s.delayHours) })), exitOnBooking: edit.exitOnBooking }; if (edit.id) await api(`/api/orgs/campaigns/sequences/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api(`/api/orgs/campaigns/sequences`, { method: "POST", body: JSON.stringify(body) }); setEdit(null); reload(); } catch (e) { setMsg(e.message); } };
  if (edit) return (
    <div className={`${panel} space-y-3`}>
      <input className={`${input} w-full`} placeholder="Sequence name, e.g. After consultation" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      <label className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)]"><input type="checkbox" checked={edit.exitOnBooking} onChange={(e) => setEdit({ ...edit, exitOnBooking: e.target.checked })} /> Stop when the person books an appointment</label>
      {edit.steps.map((s, i) => (
        <div key={i} className="border border-white/10 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)]">Email {i + 1}, send <input type="number" className={`${input} w-20`} value={s.delayHours} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, delayHours: e.target.value } : x)) })} /> hours {i === 0 ? "after they're added" : "after the previous email"}<button className={`${ghost} ml-auto`} onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })}>Remove</button></div>
          <input className={`${input} w-full`} placeholder="Subject" value={s.subject} onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)) })} />
          <BlockEditor blocks={s.blocks} setBlocks={(b) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, blocks: b } : x)) })} />
        </div>
      ))}
      <button className={ghost} onClick={() => setEdit({ ...edit, steps: [...edit.steps, { delayHours: 72, subject: "", blocks: [{ type: "text", text: "Hi {{first_name|there}},\n\n" }] }] })}>+ Email</button>
      <p className={muted}>Saving changes puts the sequence back to draft; it must be approved again before it sends. People already in it wait meanwhile.</p>
      <div className="flex gap-2"><button className={primary} onClick={save}>Save</button><button className={ghost} onClick={() => setEdit(null)}>Cancel</button></div>
      {msg && <p className="text-red-300 text-sm">{msg}</p>}
    </div>
  );
  return (
    <div className={panel}>
      <div className="flex justify-between mb-2"><h3 className={h3n}>Follow-up sequences</h3>{options.can.edit && <button className={primary} onClick={() => setEdit({ name: "", exitOnBooking: true, steps: [{ delayHours: 24, subject: "Thanks for your time, {{first_name|there}}", blocks: [{ type: "text", text: "Hi {{first_name|there}},\n\nThank you for meeting with us." }] }] })}>New sequence</button>}</div>
      <p className={`${muted} mb-3`}>Automatic follow-up emails. People are added by a workflow (enquiry → nurture, meeting → follow-up), after a completed appointment (Appointments → Setup → Settings), after a campaign, or by hand. Unsubscribes, bounces and spam reports take them out.</p>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {msg && <p className="text-sm text-[var(--inaya-text-primary)] mb-2">{msg}</p>}
      {(data?.sequences || []).length === 0 && <p className={muted}>No sequences yet.</p>}
      <div className="space-y-2">{(data?.sequences || []).map((s) => {
        const mine = s.approval?.requestedBy && options.me && s.approval.requestedBy.toLowerCase() === options.me.toLowerCase();
        return (
          <div key={s.id} className={`${row} flex-col items-stretch`}>
            <div className="flex items-center justify-between gap-2"><p className="text-sm text-[var(--inaya-text-primary)]">{s.name} <span className={muted}>· {s.steps.length} emails · {s.stats.enrolled} added · {s.stats.sent} sent · {s.stats.opened} opened · {s.stats.clicked} clicked</span></p><Badge status={s.status} /></div>
            <div className="flex flex-wrap gap-2">
              {options.can.edit && <button className={ghost} onClick={() => setEdit({ ...s })}>Edit</button>}
              {options.can.edit && ["DRAFT", "PAUSED"].includes(s.status) && <button className={ghost} onClick={() => act(s.id, "submit", {}, "Submitted.")}>{s.status === "PAUSED" ? "Resume" : "Submit for approval"}</button>}
              {options.can.approve && s.status === "PENDING_APPROVAL" && !mine && <><button className={ghost} onClick={() => act(s.id, "approve", {}, "Approved: it's active.")}>Approve</button><button className={ghost} onClick={() => act(s.id, "reject", { note: window.prompt("What should change?") || "" }, "Sent back.")}>Request changes</button></>}
              {s.status === "ACTIVE" && <button className={ghost} onClick={() => act(s.id, "pause", {}, "Paused.")}>Pause</button>}
              {options.can.edit && <span className="flex gap-1"><input className={`${input} !py-1`} placeholder="email to add" value={enroll[s.id] || ""} onChange={(e) => setEnroll({ ...enroll, [s.id]: e.target.value })} /><button className={ghost} disabled={!enroll[s.id]} onClick={() => act(s.id, "enroll", { email: enroll[s.id] }, "Added (unless unsubscribed or already in it).")}>Add</button></span>}
            </div>
          </div>
        );
      })}</div>
    </div>
  );
}

// -------------------------------------------------------------- segments

function Segments({ orgId, options }) {
  const [data, reload, err] = useLoad(() => api(`/api/orgs/campaigns/segments?orgId=${orgId}`), [orgId]);
  const [depts] = useLoad(() => api(`/api/orgs/departments?orgId=${orgId}`).catch(() => ({ departments: [] })), [orgId]);
  const [edit, setEdit] = useState(null);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState("");
  const save = async () => { setMsg(""); try { const body = { orgId, name: edit.name, rules: cleanRules(edit.rules) }; if (edit.id) await api(`/api/orgs/campaigns/segments/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api(`/api/orgs/campaigns/segments`, { method: "POST", body: JSON.stringify(body) }); setEdit(null); reload(); } catch (e) { setMsg(e.message); } };
  if (edit) return (
    <div className={`${panel} space-y-3`}>
      <input className={`${input} w-full`} placeholder="Segment name, e.g. Inactive customers" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      <RulesForm rules={edit.rules} setRules={(r) => setEdit({ ...edit, rules: r })} departments={depts?.departments} />
      <div className="flex gap-2"><button className={ghost} onClick={async () => { try { setPreview(await api(`/api/orgs/campaigns/audience/preview`, { method: "POST", body: JSON.stringify({ orgId, rules: cleanRules(edit.rules) }) })); } catch (e) { setMsg(e.message); } }}>Count</button><button className={primary} disabled={!edit.name} onClick={save}>Save segment</button><button className={ghost} onClick={() => setEdit(null)}>Cancel</button></div>
      {preview && <p className="text-sm text-[var(--inaya-text-primary)]">{preview.count.toLocaleString()} people. {preview.description}</p>}
      {msg && <p className="text-red-300 text-sm">{msg}</p>}
    </div>
  );
  return (
    <div className={panel}>
      <div className="flex justify-between mb-3"><h3 className={h3n}>Segments</h3>{options.can.edit && <button className={primary} onClick={() => { setPreview(null); setEdit({ name: "", rules: {} }); }}>New segment</button>}</div>
      <p className={`${muted} mb-3`}>Saved audiences built from the CRM. They&apos;re worked out again at send time, so they stay current.</p>
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {(data?.segments || []).length === 0 && <p className={muted}>No segments yet. Tip: &quot;Customers inactive for 90 days&quot; for re-engagement.</p>}
      <div className="space-y-2">{(data?.segments || []).map((s) => <div key={s.id} className={row}><div><p className="text-sm text-[var(--inaya-text-primary)]">{s.name}</p><p className={muted}>{s.description}</p></div>{options.can.edit && <div className="flex gap-2"><button className={ghost} onClick={() => { setPreview(null); setEdit({ ...s }); }}>Edit</button><button className={ghost} onClick={async () => { await api(`/api/orgs/campaigns/segments/${s.id}`, { method: "PATCH", body: JSON.stringify({ orgId, archived: true }) }).catch(() => {}); reload(); }}>Delete</button></div>}</div>)}</div>
    </div>
  );
}

// ---------------------------------------------------------- suppressions

function Suppressions({ orgId, options }) {
  const [q, setQ] = useState("");
  const [data, reload, err] = useLoad(() => api(`/api/orgs/campaigns/suppressions?orgId=${orgId}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [orgId, q]);
  const [add, setAdd] = useState("");
  const [bulk, setBulk] = useState("");
  const [msg, setMsg] = useState("");
  const call = async (method, body, ok) => { setMsg(""); try { const r = await api(`/api/orgs/campaigns/suppressions`, { method, body: JSON.stringify({ orgId, ...body }) }); setMsg(ok(r)); reload(); } catch (e) { setMsg(e.message); } };
  return (
    <div className={`${panel} space-y-3`}>
      <h3 className={h3}>Do-not-email list <span className={muted}>({data?.total ?? "…"} addresses)</span></h3>
      <p className={muted}>Unsubscribes, hard bounces and spam reports are added automatically and never receive marketing email again. Booking confirmations and reminders still go out.</p>
      <input className={`${input} w-full`} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {options.can.manage && <>
        <div className="flex gap-2"><input className={`${input} flex-1`} placeholder="email@example.com" value={add} onChange={(e) => setAdd(e.target.value)} /><button className={ghost} disabled={!add} onClick={() => call("POST", { email: add }, () => { setAdd(""); return "Added."; })}>Add</button></div>
        <details><summary className={`${muted} cursor-pointer`}>Import an existing unsubscribe list</summary><textarea className={`${input} w-full mt-2`} rows={4} placeholder="Paste addresses, one per line or comma-separated" value={bulk} onChange={(e) => setBulk(e.target.value)} /><button className={`${ghost} mt-1`} disabled={!bulk} onClick={() => call("POST", { importText: bulk }, (r) => { setBulk(""); return `${r.added} added, ${r.alreadyListed} already listed.`; })}>Import</button></details>
      </>}
      {msg && <p className="text-sm text-[var(--inaya-text-primary)]">{msg}</p>}
      <div className="space-y-1">{(data?.suppressions || []).map((s) => <div key={s.email} className={row}><span className="text-sm text-[var(--inaya-text-primary)] truncate">{s.email}</span><span className={muted}>{label(s.reason)} · {fmt(s.createdAt)}</span>{options.can.manage && ["manual", "bounced"].includes(s.reason) && <button className={ghost} onClick={() => call("DELETE", { email: s.email }, () => "Removed.")}>Remove</button>}</div>)}</div>
    </div>
  );
}

// --------------------------------------------------------------- settings

function Settings({ orgId, options, reloadOptions, canManageOrg }) {
  const [data, reload] = useLoad(() => api(`/api/orgs/campaigns/settings?orgId=${orgId}`), [orgId]);
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  const [members, setMembers] = useState(options.members || []);
  useEffect(() => { if (data?.settings) setS(data.settings); }, [data]);
  const save = async () => { setMsg(""); try { await api(`/api/orgs/campaigns/settings`, { method: "PUT", body: JSON.stringify({ orgId, ...s }) }); setMsg("Saved."); reload(); } catch (e) { setMsg(e.message); } };
  const setRole = async (email, marketingRole) => { setMsg(""); try { await api(`/api/orgs/campaigns/roles`, { method: "PUT", body: JSON.stringify({ orgId, email, marketingRole: marketingRole || null }) }); setMembers((m) => m.map((x) => (x.email === email ? { ...x, marketingRole: marketingRole || null } : x))); reloadOptions(); } catch (e) { setMsg(e.message); } };
  if (!s) return <p className={muted}>Loading…</p>;
  const can = options.can.manage;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className={`${panel} space-y-3`}>
        <h3 className={h3}>Sender</h3>
        <label className="block space-y-1"><span className={muted}>From name</span><input disabled={!can} className={`${input} w-full`} value={s.fromName} onChange={(e) => setS({ ...s, fromName: e.target.value })} /></label>
        <p className={muted}>Sent from {options.sender.configured ? options.sender.fromAddress : "the marketing sending domain (not connected yet)"}, a separate domain so campaign mail never affects your sign-in or booking emails.</p>
        <label className="block space-y-1"><span className={muted}>Replies go to</span><input disabled={!can} className={`${input} w-full`} value={s.replyTo} onChange={(e) => setS({ ...s, replyTo: e.target.value })} /></label>
        <label className="block space-y-1"><span className={muted}>Postal address (required by anti-spam laws)</span><input disabled={!can} className={`${input} w-full`} value={s.postalAddress} onChange={(e) => setS({ ...s, postalAddress: e.target.value })} /></label>
        <label className="block space-y-1"><span className={muted}>Why people get your emails (footer)</span><input disabled={!can} className={`${input} w-full`} value={s.audienceReason} onChange={(e) => setS({ ...s, audienceReason: e.target.value })} /></label>
        <label className="block space-y-1"><span className={muted}>Booking page for {"{{booking_url}}"}</span><input disabled={!can} className={`${input} w-full`} placeholder="your-page-address" value={s.bookingPageSlug} onChange={(e) => setS({ ...s, bookingPageSlug: e.target.value })} /></label>
        <label className="block space-y-1"><span className={muted}>Brand colour</span><input disabled={!can} type="color" className="h-9 w-16 bg-transparent" value={s.brandColor} onChange={(e) => setS({ ...s, brandColor: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)]"><input disabled={!can} type="checkbox" checked={s.requireApproval} onChange={(e) => setS({ ...s, requireApproval: e.target.checked })} /> A second person must approve every campaign and sequence</label>
        {can && <button className={primary} onClick={save}>Save</button>}
        {msg && <p className="text-sm text-[var(--inaya-text-primary)]">{msg}</p>}
        {options.usage && <p className={muted}>Plan allowance: {options.usage.limit.toLocaleString()} marketing emails a month.</p>}
      </div>
      {canManageOrg && (
        <div className={panel}>
          <h3 className={h3}>Marketing roles</h3>
          <p className={`${muted} mb-3`}>Editors build and submit campaigns. Approvers approve or send back. Managers do both and change settings. Owners and admins are managers.</p>
          {members.map((m) => <div key={m.email} className={`${row} mb-1`}><span className="text-sm text-[var(--inaya-text-primary)] truncate">{m.email}</span><select className={input} value={m.marketingRole || ""} onChange={(e) => setRole(m.email, e.target.value)}><option value="">No access</option><option value="editor">Editor</option><option value="approver">Approver</option><option value="manager">Manager</option></select></div>)}
        </div>
      )}
    </div>
  );
}
