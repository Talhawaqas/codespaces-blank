"use client";

// src/app/room/[token]/page.js
//
// The visitor side of Data Room 2.0 (no account). Opening the emailed link proves control of the email address (it sets a room session
// cookie), the visitor accepts the NDA if the room has one, then sees only the documents their invitation allows. To read one they enter the
// document passkey the sender shared separately; the encrypted file is fetched through Inaya and decrypted in this browser inside the secure
// viewer (watermark, view-only or restricted mode, time-limited). Visitors can ask questions and see only their own questions and answers.

import { useCallback, useEffect, useRef, useState, use } from "react";
import SecureViewer from "../../../components/viewer/SecureViewer";
import { dataUrlToFile, decryptData } from "../../../components/viewer/decrypt";

const input = "w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]";
const primary = "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";
const ghost = "px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase border border-white/15 text-white disabled:opacity-40";
const api = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Something went wrong."), { status: r.status });
  return d;
};
const device = () => { try { let id = localStorage.getItem("inaya-room-device"); if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem("inaya-room-device", id); } return id; } catch { return undefined; } };
const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

import BrandHeader from "../../../components/BrandHeader";
export default function RoomPage({ params }) {
  const { token } = use(params);
  const [state, setState] = useState("verifying"); const [error, setError] = useState(""); const [data, setData] = useState(null);
  const [opening, setOpening] = useState(null); const [passkey, setPasskey] = useState(""); const [busy, setBusy] = useState(false); const [view, setView] = useState(null);
  const [questions, setQuestions] = useState([]); const [qText, setQText] = useState(""); const [qDoc, setQDoc] = useState("");
  const viewRef = useRef(null);

  const load = useCallback(async () => { const d = await api("/api/data-room-access/v2/documents"); setData(d); if (!d.ndaRequired) setQuestions((await api("/api/data-room-access/v2/questions").catch(() => ({ questions: [] }))).questions); }, []);
  useEffect(() => {
    (async () => {
      try {
        const ex = await fetch(`/api/data-room-access/${encodeURIComponent(token)}`, { credentials: "include" });
        // A link works once. On a refresh the exchange fails but the session cookie from the first visit may still be valid.
        if (!ex.ok) { const msg = (await ex.json().catch(() => ({}))).error || "This link is invalid or has expired."; try { await load(); } catch { throw new Error(msg); } setState("ready"); return; }
        await load(); setState("ready");
      } catch (e) { setError(e.message); setState("error"); }
    })();
  }, [token, load]);

  async function accept() { try { await api("/api/data-room-access/nda", { method: "POST" }); await load(); } catch (e) { setError(e.message); } }

  async function openDoc(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const o = await api("/api/data-room-access/v2/open", { method: "POST", body: JSON.stringify({ documentId: opening.id, deviceId: device() }) });
      const get = async (part) => JSON.parse((await api(`/api/data-room-access/v2/content?viewId=${encodeURIComponent(o.viewId)}&part=${part}`)).content).shard;
      const [a, b] = await Promise.all([get("alpha"), get("beta")]);
      let dataUrl; try { dataUrl = await decryptData(a + b, passkey); } catch { throw new Error("Could not decrypt this document. Check the passkey and try again."); }
      viewRef.current = o.viewId; setView({ ...o, file: { ...dataUrlToFile(dataUrl), name: o.filename } }); setPasskey("");
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  }
  const signal = useCallback((type) => { if (viewRef.current) fetch("/api/data-room-access/v2/signal", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ viewId: viewRef.current, type }) }).catch(() => {}); }, []);
  const close = () => { signal("VIEW_CLOSED"); viewRef.current = null; setView(null); setOpening(null); };

  async function ask(e) { e.preventDefault(); try { await api("/api/data-room-access/v2/questions", { method: "POST", body: JSON.stringify({ text: qText, documentId: qDoc || undefined }) }); setQText(""); setQuestions((await api("/api/data-room-access/v2/questions")).questions); } catch (e2) { setError(e2.message); } }

  const bySection = (data?.documents || []).reduce((m, d) => { (m[d.section || "Documents"] ||= []).push(d); return m; }, {});
  return (
    <main className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-5">
        <BrandHeader branding={data?.branding} />
        {state === "verifying" && <p className="text-center text-sm text-[#8a96ab]">Verifying your link…</p>}
        {state === "error" && <div role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-5 text-sm text-red-200">{error} Ask the sender for a new link.</div>}
        {state === "ready" && data && (<>
          <div><p className="text-xs uppercase tracking-wider text-[#8a96ab]">Data room</p><h2 className="text-xl font-bold text-white">{data.room?.name}</h2></div>
          {error && <p role="alert" className="text-red-300 text-xs">{error}</p>}
          {data.ndaRequired ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-5 text-sm space-y-3"><p className="font-bold text-white">Confidentiality terms</p><p className="whitespace-pre-wrap">{data.ndaText || "Please accept the confidentiality terms to continue."}</p><button className={primary} onClick={accept}>I accept</button></div>
          ) : view ? (
            <div className="space-y-3"><div className="flex items-center gap-2"><button className={ghost} onClick={close}>← Back to documents</button><p className="text-sm text-white break-all">{view.filename}{view.final ? " · final version" : ""}</p></div>
              <SecureViewer file={view.file} mode={view.mode === "download" ? "normal" : "restricted"} watermark={view.watermark} expiresAt={view.expiresAt} canDownload={view.mode === "download"} onSignal={signal} onExpire={close}
                onDownload={() => { const u = URL.createObjectURL(new Blob([view.file.bytes], { type: view.file.mime })); const a = document.createElement("a"); a.href = u; a.download = view.file.name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }} /></div>
          ) : opening ? (
            <form onSubmit={openDoc} className="rounded-xl border border-white/10 bg-[#090d16]/80 p-5 space-y-3">
              <p className="text-sm text-white break-all">{opening.filename} <span className="text-[#8a96ab]">· {size(opening.size)} · {opening.canDownload ? "view or download" : "view only"}</span></p>
              <input className={input} type="password" autoComplete="off" placeholder="Document passkey" value={passkey} onChange={(e) => setPasskey(e.target.value)} aria-label="Document passkey" />
              <div className="flex gap-2"><button className={primary} disabled={busy || !passkey}>{busy ? "Decrypting…" : "Open"}</button><button type="button" className={ghost} onClick={() => setOpening(null)}>Cancel</button></div>
              <p className="text-[12px] text-[#8a96ab]">Decryption happens in this browser. The passkey is never sent to Inaya. Ask the sender if you do not have it.</p>
            </form>
          ) : (<>
            {Object.keys(bySection).length === 0 && <p className="text-sm text-[#8a96ab]">There are no documents for you here yet.</p>}
            {Object.entries(bySection).map(([sec, docs]) => (
              <section key={sec}><h3 className="text-xs font-bold uppercase tracking-wider text-[#8a96ab] mb-2">{sec}</h3>
                <div className="space-y-2">{docs.map((d) => <div key={d.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#090d16]/80 px-4 py-3"><div className="min-w-0 flex-1"><p className="text-sm text-white truncate">{d.filename}</p><p className="text-[11px] text-[#8a96ab]">{size(d.size)} · {d.canDownload ? "view or download" : "view only"}{d.final ? " · final version" : ""}</p></div><button className={ghost} onClick={() => setOpening(d)}>Open</button></div>)}</div></section>))}
            <section className="rounded-xl border border-white/10 p-4 space-y-2"><h3 className="text-xs font-bold uppercase tracking-wider text-[#8a96ab]">Questions</h3>
              <form onSubmit={ask} className="space-y-2"><select aria-label="About" className={input} value={qDoc} onChange={(e) => setQDoc(e.target.value)}><option value="">About the room in general</option>{data.documents.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}</select><textarea aria-label="Your question" className={input} rows={2} value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Ask the team a question" /><button className={primary} disabled={!qText.trim()}>Send question</button></form>
              {questions.map((q) => <div key={q.id} className="text-[12px] border-t border-white/10 pt-2"><p className="text-white">{q.text}</p>{q.answer ? <p className="text-emerald-300">Answer: {q.answer}</p> : <p className="text-[#8a96ab]">Waiting for an answer.</p>}</div>)}
              <p className="text-[11px] text-[#8a96ab]">Only you and the room owners can see your questions.</p></section>
            <p className="text-[11px] text-[#8a96ab]">Your access can be ended by the room owner at any time and ends automatically after the time they set. Every time you open a document is recorded.</p>
          </>)}
        </>)}
      </div>
    </main>
  );
}
