"use client";

// app/request/[token]/page.js
//
// The public upload page for a file request (Competitive Expansion SOW B3). No account. The visitor can send files and nothing else:
// they cannot see what others sent or anything about the organization. Each file is encrypted in THIS browser to a key only the requester
// can open, then uploaded in small encrypted parts. See docs/architecture/secure-sharing-model.md.

import { use, useEffect, useState } from "react";
import { encryptForRequest } from "../../../lib/filerequests/clientCrypto";

const input = "w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]";
const primary = "w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";

const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Something went wrong."), { status: r.status, code: d.code });
  return d;
};
const sizeOf = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const extOf = (name) => (String(name).includes(".") ? String(name).split(".").pop().toLowerCase() : "");

export default function RequestPage({ params }) {
  const { token } = use(params);
  const [info, setInfo] = useState(null); const [error, setError] = useState("");
  const [f, setF] = useState({ name: "", email: "", company: "", note: "" }); const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState([]); const [done, setDone] = useState([]);

  useEffect(() => { fetch(`/api/public/file-requests/${token}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "This link is invalid."); setInfo(d); }).catch((e) => setError(e.message)); }, [token]);

  const problems = (list) => {
    const out = [];
    for (const file of list) {
      const ext = extOf(file.name);
      if (info.allowedExtensions?.length && !info.allowedExtensions.includes(ext)) out.push(`${file.name}: only ${info.allowedExtensions.join(", ")} files are accepted.`);
      if (file.size > info.maxFileBytes) out.push(`${file.name} is larger than ${sizeOf(info.maxFileBytes)}.`);
      if (file.size === 0) out.push(`${file.name} is empty.`);
    }
    if (list.length > info.remaining) out.push(`You can send at most ${info.remaining} more file${info.remaining === 1 ? "" : "s"}.`);
    return out;
  };

  async function send(e) {
    e.preventDefault(); setError("");
    const issues = problems(files); if (issues.length) { setError(issues[0]); return; }
    setBusy(true); setDone([]); setProgress(files.map((x) => ({ name: x.name, state: "waiting" })));
    const receipts = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]; const upd = (state) => setProgress((p) => p.map((x, j) => (j === i ? { ...x, state } : x)));
        upd("encrypting");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const enc = await encryptForRequest(info.publicKeyJwk, bytes, { name: file.name, type: file.type }, info.requestId);
        const partBytes = info.partBytes; const partCount = Math.max(1, Math.ceil(enc.ciphertext.length / partBytes));
        upd("uploading");
        const begin = await post(`/api/public/file-requests/${token}`, { action: "begin", uploader: f, ext: extOf(file.name), size: enc.ciphertext.length, partCount, keyEnvelope: enc.keyEnvelope });
        for (let p = 0; p < partCount; p++) {
          const chunk = enc.ciphertext.subarray(p * partBytes, (p + 1) * partBytes);
          let bin = ""; for (let k = 0; k < chunk.length; k += 0x8000) bin += String.fromCharCode(...chunk.subarray(k, k + 0x8000));
          await post(`/api/public/file-requests/${token}`, { action: "part", uploadId: begin.uploadId, uploadKey: begin.uploadKey, index: p, data: btoa(bin) });
        }
        const r = await post(`/api/public/file-requests/${token}`, { action: "complete", uploadId: begin.uploadId, uploadKey: begin.uploadKey });
        receipts.push({ name: file.name, receiptId: r.receiptId }); upd("sent");
      }
      setDone(receipts); setFiles([]);
      setInfo((x) => ({ ...x, remaining: Math.max(0, x.remaining - receipts.length) }));
    } catch (e2) { setError(e2.message); setProgress((p) => p.map((x) => (x.state === "uploading" || x.state === "encrypting" ? { ...x, state: "failed" } : x))); }
    finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4 py-8">
      <div className="max-w-md w-full">
        <h1 className="text-lg font-extrabold text-white text-center mb-1">INAYA <span className="text-[#00f2fe]">NETWORK</span></h1>
        <p className="text-[#8a96ab] text-xs text-center mb-6">Secure file upload</p>
        {!info && !error && <p className="text-[#8a96ab] text-sm text-center">Loading…</p>}
        {error && !info && <div className="bg-red-400/10 border border-red-400/20 rounded-2xl p-6 text-center"><p className="text-red-400 text-sm">{error}</p><p className="text-[#8a96ab] text-xs mt-2">Ask whoever sent you this link for a new one.</p></div>}
        {info && info.status !== "open" && <div className="bg-red-400/10 border border-red-400/20 rounded-2xl p-6 text-center"><p className="text-red-400 text-sm">{info.error}</p></div>}
        {info?.status === "open" && (
          <form onSubmit={send} className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-3">
            <div><p className="text-white text-sm font-bold">{info.title}</p>{info.organization && <p className="text-[#8a96ab] text-xs">Requested by {info.organization}</p>}</div>
            {info.instructions && <p className="text-[#c8d3e6] text-xs whitespace-pre-wrap">{info.instructions}</p>}
            {info.requireIdentity.name && <input className={input} placeholder="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Your name" required />}
            {info.requireIdentity.email && <input className={input} type="email" placeholder="Your email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Your email" required />}
            {info.requireIdentity.company && <input className={input} placeholder="Your company" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} aria-label="Your company" required />}
            <input className={input} placeholder="A note for them (optional)" maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} aria-label="Note" />
            <label className="block"><span className="text-xs text-[#8a96ab]">Files (up to {info.remaining}, {sizeOf(info.maxFileBytes)} each{info.allowedExtensions?.length ? `, ${info.allowedExtensions.join(", ")} only` : ""})</span>
              <input type="file" multiple className={`${input} mt-1`} onChange={(e) => { const picked = Array.from(e.target.files || []); setFiles(picked); setError(problems(picked)[0] || ""); }} aria-label="Files to send" /></label>
            {files.length > 0 && <ul className="text-xs text-[#c8d3e6] space-y-0.5">{files.map((x, i) => <li key={i}>{x.name} <span className="text-[#8a96ab]">({sizeOf(x.size)})</span></li>)}</ul>}
            <button className={primary} disabled={busy || !files.length || !!problems(files).length}>{busy ? "Encrypting and sending…" : "Send securely"}</button>
            <p className="text-[#8a96ab] text-[11px]">Your files are encrypted on your device before they are sent. Only the person who asked can open them, and Inaya cannot read them. Because of that, files cannot be scanned for viruses on the way in. Only send files you trust. You will not be able to see other people&apos;s files.</p>
          </form>)}
        {progress.length > 0 && <ul className="mt-3 text-xs space-y-1" aria-live="polite">{progress.map((p, i) => <li key={i} className={p.state === "failed" ? "text-red-400" : p.state === "sent" ? "text-emerald-400" : "text-[#8a96ab]"}>{p.name}: {p.state}</li>)}</ul>}
        {error && info && <p className="text-red-400 text-xs mt-3 text-center" role="alert">{error}</p>}
        {done.length > 0 && <div className="mt-3 bg-emerald-400/10 border border-emerald-400/20 rounded-2xl p-4 text-center"><p className="text-emerald-400 text-sm">Sent. Thank you.</p><p className="text-[#8a96ab] text-[11px] mt-1">Receipt: {done.map((d) => d.receiptId.slice(-8)).join(", ")}</p></div>}
      </div>
    </div>
  );
}
