"use client";

// src/components/shares/V2Viewer.js
//
// The recipient side of a Secure Sharing 2.0 link (no account needed). Steps: satisfy the link's rules (password, work email +
// emailed code), receive a short-lived access session, fetch the ENCRYPTED pieces through Inaya, then decrypt in this browser with the
// passkey the owner sent separately. Inaya never sees the passkey or the readable file.
//
// View-only mode shows the document here and offers no download button and hides it when printing; it is a best-effort viewer mode, not
// protection against someone who has the passkey (the page says so).

import { useEffect, useRef, useState } from "react";

async function decryptData(base64Str, password) {
  const binaryStr = window.atob(base64Str);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) combined[i] = binaryStr.charCodeAt(i);
  const salt = combined.slice(0, 16); const iv = combined.slice(16, 28); const encrypted = combined.slice(28);
  const keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted));
}

const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Something went wrong."), { status: r.status, needs: d.needs });
  return d;
};

function deviceId() {
  try {
    let id = localStorage.getItem("inaya-share-device");
    if (!id) { id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem("inaya-share-device", id); }
    return id;
  } catch { return undefined; }
}

const input = "w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]";
const primary = "w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";

export default function V2Viewer({ token, peek }) {
  const [password, setPassword] = useState(""); const [email, setEmail] = useState(""); const [code, setCode] = useState(""); const [codeSent, setCodeSent] = useState(false);
  const [session, setSession] = useState(null); const [passkey, setPasskey] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [file, setFile] = useState(null); // { dataUrl, mime }
  const timer = useRef(null);

  // The access session is short-lived: tell the visitor and clear the decrypted document when it ends.
  useEffect(() => {
    if (!session) return;
    const ms = new Date(session.expiresAt).getTime() - Date.now();
    timer.current = setTimeout(() => { setSession(null); setFile(null); setPasskey(""); setErr("Your access has timed out. Open the link again to continue."); }, Math.max(ms, 1000));
    return () => clearTimeout(timer.current);
  }, [session]);

  if (peek.status !== "active") return (
    <div className="bg-red-400/10 border border-red-400/20 rounded-2xl p-6 text-center"><p className="text-red-400 text-sm">{peek.error || "This link is not available."}</p><p className="text-[#8a96ab] text-xs mt-2">Ask whoever shared this with you for a new link.</p></div>);

  async function open(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try { setSession(await post(`/api/orgs/share/${token}/access`, { password: password || undefined, email: email || undefined, code: code || undefined, deviceId: deviceId() })); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  async function sendCode() {
    setBusy(true); setErr("");
    try { const r = await post(`/api/orgs/share/${token}/code`, { email }); if (r.sent === false) setErr(r.error || "We could not send the code right now."); else setCodeSent(true); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  async function decrypt(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const get = async (part) => { const r = await fetch(`/api/orgs/share/${token}/content?part=${part}`, { headers: { "x-share-session": session.sessionToken } }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Could not fetch the document."); return JSON.parse(d.content).shard; };
      const [a, b] = await Promise.all([get("alpha"), get("beta")]);
      let dataUrl; try { dataUrl = await decryptData(a + b, passkey); } catch { throw new Error("Could not decrypt this document. Check the passkey and try again."); }
      const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "application/octet-stream";
      if (session.permission === "download") { const el = document.createElement("a"); el.href = dataUrl; el.download = session.filename; el.click(); setFile(null); } else setFile({ dataUrl, mime });
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      {!session ? (
        <form onSubmit={open} className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-2">
          <p className="text-white text-sm font-bold">{peek.label || "Shared document"}</p>
          <p className="text-[#8a96ab] text-xs mb-2">{peek.requires.password || peek.requires.email ? "This link is protected." : "Open this link to continue."}</p>
          {peek.requires.email && (<>
            <input className={input} type="email" autoComplete="email" placeholder="Your work email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Work email" />
            <button type="button" onClick={sendCode} disabled={busy || !email} className="w-full py-2 rounded-xl text-xs font-bold uppercase border border-white/10 text-white disabled:opacity-40">{codeSent ? "Send the code again" : "Email me a code"}</button>
            <input className={input} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code from your email" />
          </>)}
          {peek.requires.password && <input className={input} type="password" autoComplete="off" placeholder="Link password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Link password" />}
          <button className={primary} disabled={busy}>{busy ? "Checking…" : "Open"}</button>
        </form>
      ) : (
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
          <p className="text-xs text-[#8a96ab] uppercase tracking-wider mb-1">Document</p>
          <p className="text-white text-sm mb-1 break-words">{session.filename}</p>
          <p className="text-[#8a96ab] text-xs mb-1">{(session.sizeBytes / 1024).toFixed(1)} KB · {session.permission === "view" ? "view only" : "view and download"}</p>
          {session.note && <p className="text-[#c8d3e6] text-xs mb-3">{session.note}</p>}
          <form onSubmit={decrypt} className="space-y-2">
            <input className={input} type="password" autoComplete="off" placeholder="Encryption passkey" value={passkey} onChange={(e) => setPasskey(e.target.value)} aria-label="Encryption passkey" />
            <button className={primary} disabled={busy || !passkey}>{busy ? "Decrypting…" : session.permission === "view" ? "Decrypt and view" : "Decrypt and download"}</button>
          </form>
          <p className="text-[#8a96ab] text-[12px] mt-3">Decryption happens in this browser. The passkey is never sent to Inaya. Don&apos;t have it? Ask whoever shared this with you.</p>
          {session.permission === "view" && <p className="text-[#8a96ab] text-[11px] mt-2">View-only hides the download button and printing. It cannot prevent someone who has the passkey from keeping what they see.</p>}
        </div>)}
      {err && <p className="text-red-400 text-xs text-center" role="alert">{err}</p>}
      {file && (
        <div className="relative bg-white rounded-xl overflow-hidden share-viewer" style={{ minHeight: 320 }}>
          <style>{`@media print { .share-viewer { display: none !important; } }`}</style>
          {file.mime.startsWith("image/") ? <img src={file.dataUrl} alt="" className="max-w-full mx-auto" draggable={false} />
            : file.mime === "application/pdf" || file.mime.startsWith("text/") ? <iframe title="Shared document" src={file.dataUrl} className="w-full" style={{ height: "70vh", border: 0 }} />
            : <p className="p-6 text-sm text-slate-700">This file type cannot be previewed here.</p>}
          {session?.watermark && <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden select-none" style={{ opacity: 0.18 }}>
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="whitespace-nowrap text-slate-900 font-bold" style={{ position: "absolute", top: `${i * 14}%`, left: "-10%", transform: "rotate(-24deg)", fontSize: 18 }}>{Array(4).fill(session.watermark).join("     ")}</div>)}
          </div>}
        </div>)}
    </div>
  );
}
