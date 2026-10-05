"use client";

// src/components/portal/PortalTodo.js -- "To do" in the customer portal (Competitive Expansion SOW L): the files, forms and agreements the team asked ONE customer for.
// Rendered inside PortalApp, so it uses the portal's own pt-* styles. The API only ever returns requests addressed to the signed-in customer.
import { useCallback, useEffect, useRef, useState } from "react";

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const STATUS_LABEL = { OPEN: "Waiting for you", IN_PROGRESS: "In progress", COMPLETE: "Complete", CANCELLED: "Cancelled" };
const tone = (s) => (s === "COMPLETE" ? "ok" : s === "CANCELLED" ? "" : "warn");
const useAsync = () => {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  const run = async (fn) => { setBusy(true); setErr(""); setOk(""); try { return await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return { busy, err, ok, setOk, setErr, run };
};
const Msg = ({ a }) => <>{a.err && <p className="pt-err" role="alert">{a.err}</p>}{a.ok && <p className="pt-ok" role="status">{a.ok}</p>}</>;

export default function PortalTodo({ call, slug }) {
  const [list, setList] = useState(null); const [open, setOpen] = useState(null); const [err, setErr] = useState("");
  const load = useCallback(() => call("requests").then((d) => setList(d.requests)).catch((e) => setErr(e.message)), [call]);
  useEffect(() => { load(); }, [load]);
  if (open) return <RequestDetail call={call} slug={slug} id={open} back={() => { setOpen(null); load(); }} />;
  return (
    <>
      <h1>To do</h1>
      <p className="pt-muted">Files, forms and agreements the team has asked you for. Only you can see these.</p>
      {err && <p className="pt-err" role="alert">{err}</p>}
      <div className="pt-card">
        {!list ? <p className="pt-muted">Loading…</p> : !list.length ? <p className="pt-muted">Nothing is waiting for you.</p> : (
          <ul className="pt-list">{list.map((r) => (
            <li key={r.requestId}>
              <button className="pt-link" onClick={() => setOpen(r.requestId)}>{r.title}</button> <span className={`pt-tag ${tone(r.status)}`}>{STATUS_LABEL[r.status] || r.status}</span>
              <div className="pt-muted">{r.progress.done} of {r.progress.required} required items done{r.dueAt ? ` · due ${new Date(r.dueAt).toLocaleDateString()}` : ""}</div>
            </li>))}</ul>)}
      </div>
    </>
  );
}

function RequestDetail({ call, slug, id, back }) {
  const [r, setR] = useState(null); const [err, setErr] = useState(""); const [comment, setComment] = useState(""); const a = useAsync();
  const load = useCallback(() => call(`requests/${id}`).then((d) => setR(d.request)).catch((e) => setErr(e.message)), [call, id]);
  useEffect(() => { load(); }, [load]);
  if (!r) return <><button className="pt-link" onClick={back}>← Back</button><p className={err ? "pt-err" : "pt-muted"} role={err ? "alert" : undefined}>{err || "Loading…"}</p></>;
  const closed = r.status === "COMPLETE" || r.status === "CANCELLED";
  return (
    <>
      <button className="pt-link" onClick={back}>← Back to your list</button>
      <h1>{r.title}</h1>
      <p><span className={`pt-tag ${tone(r.status)}`}>{STATUS_LABEL[r.status] || r.status}</span> <span className="pt-muted">{r.progress.done} of {r.progress.required} required items done{r.dueAt ? ` · due ${new Date(r.dueAt).toLocaleDateString()}` : ""}</span></p>
      {r.instructions && <p>{r.instructions}</p>}
      <Msg a={a} />
      {r.items.map((it) => <Item key={it.itemId} it={it} r={r} call={call} slug={slug} reload={load} disabled={closed} a={a} />)}
      <div className="pt-card">
        <h2 style={{ marginTop: 0 }}>Notes</h2>
        {r.comments.length === 0 ? <p className="pt-muted">No notes yet.</p> : r.comments.map((c, i) => <p key={i}><strong>{c.by === "staff" ? "Team" : "You"}</strong> <span className="pt-muted">{fmt(c.at)}</span><br />{c.text}</p>)}
        {r.status !== "CANCELLED" && (
          <div>
            <label htmlFor="req-note">Add a note</label>
            <textarea id="req-note" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="pt-btn" disabled={a.busy || !comment.trim()} onClick={() => a.run(async () => { await call(`requests/${id}/comments`, { method: "POST", body: { text: comment } }); setComment(""); await load(); })}>Send note</button>
          </div>)}
      </div>
      <div className="pt-card">
        <h2 style={{ marginTop: 0 }}>History</h2>
        <ul className="pt-list">{r.history.map((h, i) => <li key={i}><span className="pt-muted">{fmt(h.at)}</span> {h.kind.replace(/_/g, " ").toLowerCase()} <span className="pt-muted">by {h.actor}</span></li>)}</ul>
      </div>
    </>
  );
}

function Item({ it, r, call, slug, reload, disabled, a }) {
  const [vals, setVals] = useState({}); const [errs, setErrs] = useState({}); const [name, setName] = useState(""); const fileRef = useRef(null);
  const done = it.state === "DONE"; const fid = (k) => `${it.itemId}-${k}`;
  const sendFile = () => a.run(async () => {
    const f = fileRef.current?.files?.[0]; if (!f) throw new Error("Choose a file first."); if (f.size > 4 * 1024 * 1024) throw new Error("Files can be at most 4 MB here.");
    const res = await fetch(`/api/portal/${slug}/request-files?requestId=${r.requestId}&itemId=${it.itemId}&filename=${encodeURIComponent(f.name)}`, { method: "POST", credentials: "same-origin", headers: { "X-Portal-Request": "1" }, body: f });
    const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || "The file could not be sent."); a.setOk("Sent. Thank you."); await reload();
  });
  const submitForm = (e) => {
    e.preventDefault();
    a.run(async () => { try { await call(`requests/${r.requestId}/items/${it.itemId}/form`, { method: "POST", body: { values: vals } }); setErrs({}); a.setOk("Submitted. Thank you."); await reload(); } catch (e2) { setErrs(e2.data?.errors || {}); throw e2; } });
  };
  const link = (f) => <a href={`/api/portal/${slug}/request-files/${f.fileId}?requestId=${r.requestId}`} download>{f.filename}</a>;
  const input = (f) => {
    const id = fid(f.key); const set = (v) => setVals({ ...vals, [f.key]: v });
    if (f.type === "textarea") return <textarea id={id} rows={3} onChange={(e) => set(e.target.value)} />;
    if (f.type === "select") return <select id={id} defaultValue="" onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    if (f.type === "checkbox") return <input id={id} type="checkbox" style={{ width: "auto" }} onChange={(e) => set(e.target.checked)} />;
    return <input id={id} type={{ number: "number", date: "date", email: "email" }[f.type] || "text"} onChange={(e) => set(e.target.value)} />;
  };
  return (
    <div className="pt-card">
      <h2 style={{ marginTop: 0 }}>{it.title} {done ? <span className="pt-tag ok">Done</span> : it.required ? <span className="pt-tag warn">Needed</span> : <span className="pt-tag">Optional</span>}</h2>
      {it.instructions && <p>{it.instructions}</p>}
      {it.kind === "upload" && (
        <>
          {it.files.length > 0 && <ul className="pt-list">{it.files.map((f) => <li key={f.fileId}>{link(f)} <span className="pt-muted">{Math.ceil(f.sizeBytes / 1024)} KB · {fmt(f.at)}</span></li>)}</ul>}
          {!disabled && it.files.length < it.maxFiles && (
            <div>
              <label htmlFor={`f-${it.itemId}`}>Choose a file{it.accept.length ? ` (${it.accept.join(", ")})` : ""}, up to 4 MB</label>
              <input id={`f-${it.itemId}`} ref={fileRef} type="file" accept={it.accept.map((x) => "." + x).join(",")} />
              <button className="pt-btn" disabled={a.busy} onClick={sendFile}>Send file</button>
              <p className="pt-muted">Files are scanned and stored encrypted. Only you and the team can open them.</p>
            </div>)}
        </>)}
      {it.kind === "download" && (it.file ? <p>{link(it.file)} {it.downloadedAt ? <span className="pt-muted">· collected {fmt(it.downloadedAt)}</span> : null}</p> : <p className="pt-muted">The team has not released the file yet.</p>)}
      {it.kind === "form" && (done ? (
        <dl>{it.fields.map((f) => <div key={f.key}><dt className="pt-muted">{f.label}</dt><dd>{String(it.response?.[f.key] ?? "-")}</dd></div>)}</dl>
      ) : disabled ? <p className="pt-muted">This request is closed.</p> : (
        <form onSubmit={submitForm}>
          {it.fields.map((f) => <div key={f.key}><label htmlFor={fid(f.key)}>{f.label}{f.required ? " *" : ""}</label>{input(f)}{errs[f.key] && <p className="pt-err" role="alert">{errs[f.key]}</p>}</div>)}
          <button className="pt-btn" disabled={a.busy}>Submit</button>
          <p className="pt-muted">Your answers are stored encrypted. The form can be submitted once.</p>
        </form>))}
      {it.kind === "ack" && (
        <>
          <div style={{ whiteSpace: "pre-wrap", border: "1px solid var(--line)", borderRadius: 8, padding: 12, maxHeight: 260, overflow: "auto" }}>{it.text}</div>
          {done ? <p className="pt-ok">Accepted by {it.acceptance.name} on {fmt(it.acceptance.at)}. <span className="pt-muted">Reference {it.acceptance.textHash.slice(0, 12)}</span></p> : disabled ? <p className="pt-muted">This request is closed.</p> : (
            <div>
              <label htmlFor={`n-${it.itemId}`}>Type your full name to accept</label>
              <input id={`n-${it.itemId}`} value={name} onChange={(e) => setName(e.target.value)} />
              <button className="pt-btn" disabled={a.busy || name.trim().length < 2} onClick={() => a.run(async () => { await call(`requests/${r.requestId}/items/${it.itemId}/accept`, { method: "POST", body: { name, textHash: it.textHash } }); a.setOk("Accepted. Thank you."); await reload(); })}>I accept</button>
            </div>)}
        </>)}
    </div>
  );
}
