"use client";

// src/components/business/hospitality/shared.js
//
// Small shared pieces for the Hospitality OS screens: the fetch helper, the visual tokens used by every other
// industry view, a loader hook and a few form atoms. Every permission is enforced on the server; these screens
// only hide what a role can't use and show the server's own message when something is refused.

import { useState, useEffect, useCallback } from "react";

export async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { data, status: res.status });
  return data;
}
export const H = (orgId, path, params = {}) => {
  const q = new URLSearchParams({ orgId });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, v);
  return `/api/orgs/hospitality/${path}?${q}`;
};
export const send = (orgId, path, method, body = {}) => api(H(orgId, path), { method, body: JSON.stringify({ ...body, orgId }) });

export const panel = "bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5";
export const row = "flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 flex-wrap";
export const input = "bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab] min-w-0";
export const primary = "text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40";
export const ghost = "text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] disabled:opacity-40";
export const danger = "text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-red-400/30 text-red-400 hover:bg-red-400/10 disabled:opacity-40";
export const muted = "text-[var(--inaya-text-muted)] text-[12px]";
export const h3 = "text-[var(--inaya-text-primary)] font-semibold text-sm mb-3";
export const label = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export function money(minor, currency) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format((minor || 0) / 100); }
  catch { return `${currency || ""} ${((minor || 0) / 100).toFixed(2)}`; }
}
export const STATUS_TONE = { CONFIRMED: "text-[#00f2fe]", SEATED: "text-emerald-400", ARRIVED: "text-emerald-400", COMPLETED: "text-[var(--inaya-text-muted)]", PENDING_CONFIRMATION: "text-amber-400", REQUESTED: "text-amber-400", CANCELLED: "text-red-400", NO_SHOW: "text-red-400", DECLINED: "text-red-400" };

export function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try { setError(""); setData(await fn()); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(true); load(); }, [load]);
  return [data, load, error, loading];
}

/** Runs an action, shows the server's message on failure, and reports what happened (never a success toast over a failure). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const run = useCallback(async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (ok) setMsg({ ok: true, text: typeof ok === "function" ? ok(r) : ok }); return r; }
    catch (err) { setMsg({ ok: false, text: err.message, data: err.data }); return null; }
    finally { setBusy(false); }
  }, []);
  return { busy, msg, setMsg, run };
}

export function Msg({ msg }) {
  if (!msg) return null;
  return <p role={msg.ok ? "status" : "alert"} className={`text-[12px] rounded-lg px-3 py-2 border ${msg.ok ? "text-emerald-400 border-emerald-400/20 bg-emerald-400/5" : "text-red-400 border-red-400/20 bg-red-400/5"}`}>{msg.text}{msg.data?.alternatives?.length ? ` Other times: ${msg.data.alternatives.join(", ")}.` : ""}</p>;
}

export function Field({ label: text, children, hint, className = "" }) {
  return (
    <label className={`flex flex-col gap-1 text-[11px] uppercase font-bold text-[var(--inaya-text-muted)] ${className}`}>
      <span>{text}</span>{children}{hint ? <span className="normal-case font-normal">{hint}</span> : null}
    </label>
  );
}

export function State({ loading, error, empty, emptyText, children }) {
  if (error) return <p role="alert" className="text-[12px] text-red-400">{error}</p>;
  if (loading) return <p className={muted}>Loading…</p>;
  if (empty) return <p className={muted}>{emptyText}</p>;
  return children;
}

export function Stat({ label: text, value, tone = "" }) {
  return (
    <div className="bg-black/20 border border-white/5 rounded-xl p-3 min-w-[110px]">
      <p className={`text-xl font-semibold ${tone || "text-[var(--inaya-text-primary)]"}`}>{value ?? "–"}</p>
      <p className={muted}>{text}</p>
    </div>
  );
}

/** A rate from the reports API: a percentage with its counts, or a plain "not enough data" note. */
export function Rate({ label: text, r }) {
  return <Stat label={text} value={r?.status === "ok" ? `${r.value}%` : "Not enough data"} tone={r?.status === "ok" ? "" : "text-[var(--inaya-text-muted)] !text-sm"} />;
}

export function Confirm({ text, onYes, children, className = ghost, disabled }) {
  return <button type="button" disabled={disabled} className={className} onClick={() => { if (window.confirm(text)) onYes(); }}>{children}</button>;
}
