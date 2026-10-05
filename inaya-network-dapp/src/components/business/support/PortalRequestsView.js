"use client";

// src/components/business/support/PortalRequestsView.js -- customer portal requests, staff side (Competitive Expansion SOW L). Create a request for ONE customer (files to send,
// a file to collect, a secure form, an agreement), watch progress, read answers (every read is recorded), release files, comment, remind, cancel.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; } };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Request failed."); return d; };
const TONE = { OPEN: "text-amber-300", IN_PROGRESS: "text-amber-300", COMPLETE: "text-emerald-400", CANCELLED: muted };

const blankItem = (kind) => ({ kind, title: "", instructions: "", required: true, accept: "pdf", maxFiles: 1, text: "", fields: [{ key: "answer", label: "", type: "text", required: true }] });

export default function PortalRequestsView({ orgId, canManage }) {
  const [list, setList] = useState(null); const [sel, setSel] = useState(null); const [detail, setDetail] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [form, setForm] = useState(null); const [comment, setComment] = useState("");
  const load = useCallback(() => j(`/api/orgs/portal-requests?orgId=${orgId}`).then((d) => setList(d.requests)).catch((e) => { setList([]); setErr(e.message); }), [orgId]);
  useEffect(() => { if (canManage) load(); }, [load, canManage]);
  const open = (id) => { setSel(id); setDetail(null); j(`/api/orgs/portal-requests/${id}?orgId=${orgId}`).then((d) => setDetail(d.request)).catch((e) => setErr(e.message)); };
  const act = async (fn, ok) => { setErr(""); setMsg(""); try { const r = await fn(); if (ok) setMsg(ok); await load(); if (sel) open(sel); return r; } catch (e) { setErr(e.message); } };
  if (!canManage) return <EmptyState title="Customer requests" description="Only support staff can create and manage customer requests." />;

  const create = () => act(async () => {
    const items = form.items.map((i) => ({ kind: i.kind, title: i.title, instructions: i.instructions, required: i.required, ...(i.kind === "upload" ? { accept: i.accept.split(/[ ,]+/).filter(Boolean), maxFiles: Number(i.maxFiles) || 1 } : {}), ...(i.kind === "ack" ? { text: i.text } : {}), ...(i.kind === "form" ? { fields: i.fields.map((f) => ({ ...f, options: f.type === "select" ? String(f.optionsText || "").split(",").map((x) => x.trim()).filter(Boolean) : undefined })) } : {}) }));
    const r = await j("/api/orgs/portal-requests", { method: "POST", body: JSON.stringify({ orgId, customerEmail: form.customerEmail, title: form.title, instructions: form.instructions, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null, items }) });
    setForm(null); return r;
  }, "Request created. The customer was notified.");
  const release = (item, file) => act(async () => { const res = await fetch(`/api/orgs/portal-requests/${sel}/items/${item.itemId}/file?orgId=${orgId}&filename=${encodeURIComponent(file.name)}`, { method: "PUT", credentials: "include", body: file }); const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || "Could not release the file."); }, "File released. The customer was notified.");
  const setItem = (i, patch) => setForm({ ...form, items: form.items.map((x, n) => (n === i ? { ...x, ...patch } : x)) });

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex flex-wrap gap-2 items-center"><p className={muted}>Ask one customer for files, a form or an agreement. They answer in the portal after signing in with their own e-mail address. They never become members of your organization.</p><button className={accent} onClick={() => setForm({ customerEmail: "", title: "", instructions: "", dueAt: "", items: [blankItem("upload")] })}>New request</button></div>
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      {form && (
        <div className={`${card} p-3 space-y-2`}>
          <div className="flex flex-wrap gap-2"><input aria-label="Customer e-mail" className={`${field} !w-64`} placeholder="customer@example.com" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} /><input aria-label="Request title" className={`${field} !w-64`} placeholder="Title, for example Onboarding" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /><input aria-label="Due date" type="date" className={`${field} !w-40`} value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></div>
          <textarea aria-label="Instructions" className={`${field} h-14`} placeholder="Instructions for the customer" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
          {form.items.map((it, i) => (
            <div key={i} className="border-t border-[var(--inaya-overlay-10)] pt-2 space-y-1">
              <div className="flex flex-wrap gap-2 items-center"><b className="uppercase text-[10px]">{it.kind}</b><input aria-label={`Item ${i + 1} title`} className={`${field} !w-64`} placeholder="Item title" value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} /><label className="flex items-center gap-1"><input type="checkbox" checked={it.required} onChange={(e) => setItem(i, { required: e.target.checked })} />Required</label><button className={`${btn} !text-red-400`} onClick={() => setForm({ ...form, items: form.items.filter((_, n) => n !== i) })}>Remove</button></div>
              {it.kind === "upload" && <div className="flex gap-2"><input aria-label="Accepted types" className={`${field} !w-56`} placeholder="Accepted types, e.g. pdf, png" value={it.accept} onChange={(e) => setItem(i, { accept: e.target.value })} /><input aria-label="Maximum files" type="number" min="1" max="10" className={`${field} !w-24`} value={it.maxFiles} onChange={(e) => setItem(i, { maxFiles: e.target.value })} /></div>}
              {it.kind === "ack" && <textarea aria-label="Text to accept" className={`${field} h-20`} placeholder="The agreement or policy text the customer must accept" value={it.text} onChange={(e) => setItem(i, { text: e.target.value })} />}
              {it.kind === "form" && it.fields.map((f, n) => <div key={n} className="flex flex-wrap gap-2"><input aria-label="Field key" className={`${field} !w-28`} placeholder="key" value={f.key} onChange={(e) => setItem(i, { fields: it.fields.map((x, m) => (m === n ? { ...x, key: e.target.value } : x)) })} /><input aria-label="Field label" className={`${field} !w-48`} placeholder="Label" value={f.label} onChange={(e) => setItem(i, { fields: it.fields.map((x, m) => (m === n ? { ...x, label: e.target.value } : x)) })} /><select aria-label="Field type" className={`${field} !w-auto`} value={f.type} onChange={(e) => setItem(i, { fields: it.fields.map((x, m) => (m === n ? { ...x, type: e.target.value } : x)) })}>{["text", "textarea", "select", "checkbox", "date", "email", "number"].map((t) => <option key={t} value={t}>{t}</option>)}</select>{f.type === "select" && <input aria-label="Options" className={`${field} !w-48`} placeholder="Options, comma separated" value={f.optionsText || ""} onChange={(e) => setItem(i, { fields: it.fields.map((x, m) => (m === n ? { ...x, optionsText: e.target.value } : x)) })} />}<label className="flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => setItem(i, { fields: it.fields.map((x, m) => (m === n ? { ...x, required: e.target.checked } : x)) })} />Required</label></div>)}
              {it.kind === "form" && <button className={btn} onClick={() => setItem(i, { fields: [...it.fields, { key: `field${it.fields.length + 1}`, label: "", type: "text", required: false }] })}>Add field</button>}
            </div>))}
          <div className="flex flex-wrap gap-2">{["upload", "download", "form", "ack"].map((k) => <button key={k} className={btn} onClick={() => setForm({ ...form, items: [...form.items, blankItem(k)] })}>Add {k === "ack" ? "agreement" : k}</button>)}<button className={accent} disabled={!form.customerEmail || !form.title || !form.items.length} onClick={create}>Create request</button><button className={btn} onClick={() => setForm(null)}>Cancel</button></div>
        </div>)}
      {list === null ? <p className={muted}>Loading…</p> : list.length === 0 ? <EmptyState compact icon="📨" description="No customer requests yet." /> : list.map((r) => (
        <div key={r.requestId} className={`${card} p-3 flex flex-wrap items-center gap-2`}><b>{r.title}</b><span className={muted}>{r.customerEmail}</span><span className={`text-[10px] font-bold uppercase ${TONE[r.status] || ""}`}>{r.status.replace(/_/g, " ")}</span><span className={muted}>{r.progress.done}/{r.progress.required} · {when(r.createdAt)}</span><button className={btn} onClick={() => open(r.requestId)}>Open</button></div>))}
      {detail && sel && (
        <div className={`${card} p-3 space-y-2`}>
          <div className="flex flex-wrap items-center gap-2"><b>{detail.title}</b><span className={`text-[10px] font-bold uppercase ${TONE[detail.status] || ""}`}>{detail.status.replace(/_/g, " ")}</span><span className={muted}>{detail.customerEmail}</span>
            {["OPEN", "IN_PROGRESS"].includes(detail.status) && <><button className={btn} onClick={() => act(() => j(`/api/orgs/portal-requests/${sel}/remind`, { method: "POST", body: JSON.stringify({ orgId }) }), "Reminder sent.")}>Remind</button><button className={`${btn} !text-red-400`} onClick={() => window.confirm("Cancel this request? The customer can no longer act on it.") && act(() => j(`/api/orgs/portal-requests/${sel}/cancel`, { method: "POST", body: JSON.stringify({ orgId }) }), "Cancelled.")}>Cancel</button></>}</div>
          {detail.items.map((it) => (
            <div key={it.itemId} className="border-t border-[var(--inaya-overlay-10)] pt-2"><div className="flex gap-2 items-center"><b className="uppercase text-[10px]">{it.kind}</b><span>{it.title}</span><span className={it.state === "DONE" ? "text-emerald-400" : "text-amber-300"}>{it.state === "DONE" ? "done" : "waiting"}</span></div>
              {it.kind === "upload" && it.files.map((f) => <p key={f.fileId}><a className="underline" href={`/api/orgs/portal-requests/${sel}/files/${f.fileId}?orgId=${orgId}`}>{f.filename}</a> <span className={muted}>{Math.ceil(f.sizeBytes / 1024)} KB · {f.by}</span></p>)}
              {it.kind === "download" && (it.file ? <p>Released: {it.file.filename} <span className={muted}>{it.downloadedAt ? `collected ${when(it.downloadedAt)}` : "not collected yet"}</span></p> : <label className="block">Release a file (up to 4 MB) <input type="file" aria-label="Release a file" onChange={(e) => e.target.files?.[0] && release(it, e.target.files[0])} /></label>)}
              {it.kind === "form" && it.response && <dl>{it.fields.map((f) => <div key={f.key} className="flex gap-2"><dt className={muted}>{f.label}</dt><dd>{String(it.response[f.key] ?? "-")}</dd></div>)}<p className={muted}>Reading answers is recorded in the audit trail.</p></dl>}
              {it.kind === "ack" && (it.acceptance ? <p className="text-emerald-400">Accepted by {it.acceptance.name} ({it.acceptance.email}) on {when(it.acceptance.at)}. Text reference {it.acceptance.textHash.slice(0, 12)}</p> : <p className={muted}>Not accepted yet.</p>)}</div>))}
          <div className="border-t border-[var(--inaya-overlay-10)] pt-2"><p className="font-bold">Notes</p>{detail.comments.map((c, i) => <p key={i}><b>{c.by === "staff" ? "Team" : "Customer"}</b> <span className={muted}>{when(c.at)}</span> {c.text}</p>)}
            <div className="flex gap-2"><input aria-label="Note to the customer" className={field} placeholder="Write a note the customer will see" value={comment} onChange={(e) => setComment(e.target.value)} /><button className={accent} disabled={!comment.trim()} onClick={() => act(async () => { await j(`/api/orgs/portal-requests/${sel}/comments`, { method: "POST", body: JSON.stringify({ orgId, text: comment }) }); setComment(""); }, "Sent.")}>Send</button></div></div>
          <div className="border-t border-[var(--inaya-overlay-10)] pt-2"><p className="font-bold">History</p>{detail.history.map((h, i) => <p key={i} className={muted}>{when(h.at)} · {h.kind.replace(/_/g, " ").toLowerCase()} · {String(h.actor).replace(/^customer:/, "")}</p>)}</div>
        </div>)}
    </div>
  );
}
