"use client";

// src/components/business/admin/BrandingPanel.js -- organization branding (Competitive Expansion SOW R). Owner/admin only. Images are checked on the
// server (PNG/JPEG/WebP only); text is shown as text everywhere, never as HTML.
import { useCallback, useEffect, useState } from "react";

const muted = "text-[var(--inaya-text-muted)]";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accentBtn = "text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; };
const readImage = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("Could not read that file.")); fr.readAsDataURL(file); });

export default function BrandingPanel({ orgId, canManage }) {
  const [b, setB] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [domain, setDomain] = useState("");
  const load = useCallback(async () => { try { setB(await j(`/api/orgs/branding?orgId=${orgId}`)); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { if (canManage) load(); }, [load, canManage]);
  if (!canManage) return null;
  const save = async (patch, ok = "Saved.") => { setErr(""); setMsg(""); try { setB(await j("/api/orgs/branding", { method: "PUT", body: JSON.stringify({ orgId, ...patch }) })); setMsg(ok); } catch (e) { setErr(e.message); } };
  const pick = (key, label) => (
    <div><label className={`text-[11px] font-bold uppercase ${muted}`}>{label}</label>
      <div className="flex items-center gap-2">{b?.[key] ? <><img src={b[key]} alt="" className="h-8 max-w-[96px] object-contain bg-black/30 rounded" /><button className={btn} onClick={() => save({ [key]: null }, "Removed.")}>Remove</button></> : <span className={`text-[12px] ${muted}`}>None</span>}
        <label className={`${btn} cursor-pointer`}>Choose<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { await save({ [key]: await readImage(f) }, `${label} saved.`); } catch (x) { setErr(x.message); } } }} /></label></div></div>
  );
  return (
    <div className="bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4 mt-3 space-y-3">
      <h3 className="text-sm font-bold">Branding</h3>
      <p className={`text-[12px] ${muted}`}>Shown on secure links, file-request pages, data rooms and emails. PNG, JPEG or WebP images only; text is always shown as plain text.</p>
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}{msg && <p className="text-emerald-400 text-[12px]" role="status">{msg}</p>}
      {!b ? <p className={`text-[12px] ${muted}`}>Loading…</p> : <>
        <div className="grid sm:grid-cols-3 gap-3">{pick("logo", "Logo")}{pick("favicon", "Favicon")}{pick("loginBackground", "Background")}</div>
        <div className="grid sm:grid-cols-3 gap-2">
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-title">Portal title</label><input id="br-title" className={field} defaultValue={b.portalTitle || ""} onBlur={(e) => e.target.value !== (b.portalTitle || "") && save({ portalTitle: e.target.value })} /></div>
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-accent">Accent colour</label><input id="br-accent" className={field} placeholder="#1a73e8" defaultValue={b.accent || ""} onBlur={(e) => e.target.value !== (b.accent || "") && save({ accent: e.target.value })} /></div>
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-support">Support URL (https)</label><input id="br-support" className={field} defaultValue={b.supportUrl || ""} onBlur={(e) => e.target.value !== (b.supportUrl || "") && save({ supportUrl: e.target.value })} /></div>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-terms">Terms of service (plain text)</label><textarea id="br-terms" rows={3} className={field} defaultValue={b.legal.terms || ""} onBlur={(e) => e.target.value !== (b.legal.terms || "") && save({ legal: { ...b.legal, terms: e.target.value } })} /></div>
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-privacy">Privacy notice (plain text)</label><textarea id="br-privacy" rows={3} className={field} defaultValue={b.legal.privacy || ""} onBlur={(e) => e.target.value !== (b.legal.privacy || "") && save({ legal: { ...b.legal, privacy: e.target.value } })} /></div>
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-ecolor">Email header colour</label><input id="br-ecolor" className={field} placeholder="#0b1220" defaultValue={b.email.headerColor || ""} onBlur={(e) => e.target.value !== (b.email.headerColor || "") && save({ email: { ...b.email, headerColor: e.target.value } })} /></div>
          <div><label className={`text-[11px] font-bold uppercase ${muted}`} htmlFor="br-efoot">Email footer text</label><input id="br-efoot" className={field} defaultValue={b.email.footerText || ""} onBlur={(e) => e.target.value !== (b.email.footerText || "") && save({ email: { ...b.email, footerText: e.target.value } })} /></div>
        </div>
        <div className="border-t border-[var(--inaya-overlay-10)] pt-3 space-y-2"><p className="text-[12px] font-bold">Custom domain</p>
          {b.customDomain ? <div className="text-[12px]"><p><b>{b.customDomain.domain}</b> · DNS {b.customDomain.status.replace("_", " ").toLowerCase()} · routing {b.customDomain.routing.replace("_", " ").toLowerCase()}</p><p className={muted}>Add a TXT record named <code>{b.customDomain.txtName}</code> with the value <code>{b.customDomain.txtValue}</code>.</p><p className={muted}>{b.customDomain.note}</p>
            <button className={`${btn} mt-1`} onClick={async () => { setErr(""); try { await j("/api/orgs/branding", { method: "POST", body: JSON.stringify({ orgId, action: "verifyDomain" }) }); await load(); } catch (e) { setErr(e.message); } }}>Check DNS</button></div> : null}
          <div className="flex gap-2"><input aria-label="Custom domain" className={field} placeholder="files.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} /><button className={accentBtn} disabled={!domain} onClick={async () => { setErr(""); try { await j("/api/orgs/branding", { method: "POST", body: JSON.stringify({ orgId, domain }) }); setDomain(""); await load(); } catch (e) { setErr(e.message); } }}>Request domain</button></div></div>
      </>}
    </div>
  );
}
