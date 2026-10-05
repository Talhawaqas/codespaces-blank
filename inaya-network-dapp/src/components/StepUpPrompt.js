"use client";

// src/components/StepUpPrompt.js
//
// On-screen half of step-up authentication (DLP-002). When a data-loss rule needs stronger authentication, the server answers STRONGER_AUTH_REQUIRED.
// `fetchWithStepUp` catches that answer, asks the person for a fresh authenticator code in this dialog, confirms it (POST /api/orgs/step-up) and repeats the
// request once. Mount <StepUpPrompt /> once near the top of the page.

import { useEffect, useRef, useState } from "react";

const EVENT = "inaya-step-up-request";
let waiter = null;

/** Opens the dialog for an organization; resolves true when the person confirmed a code, false if they cancelled. */
export function requestStepUp(orgId) {
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => { waiter?.(false); waiter = resolve; window.dispatchEvent(new CustomEvent(EVENT, { detail: { orgId } })); });
}

function orgIdOf(path, options) {
  try { const u = new URL(path, window.location.origin); const q = u.searchParams.get("orgId"); if (q) return q; } catch { /* not a URL */ }
  try { const b = typeof options?.body === "string" ? JSON.parse(options.body) : null; if (b?.orgId) return b.orgId; } catch { /* not JSON */ }
  return null;
}

/** fetch() that, on STRONGER_AUTH_REQUIRED, runs the step-up dialog and retries once. Returns the final Response. */
export async function fetchWithStepUp(path, options) {
  const res = await fetch(path, options);
  if (res.status !== 403) return res;
  const data = await res.clone().json().catch(() => ({}));
  if (data?.code !== "STRONGER_AUTH_REQUIRED") return res;
  const orgId = orgIdOf(path, options); if (!orgId) return res;
  return (await requestStepUp(orgId)) ? fetch(path, options) : res;
}

export default function StepUpPrompt() {
  const [open, setOpen] = useState(null); const [code, setCode] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const input = useRef(null);
  useEffect(() => { const on = (e) => { setOpen(e.detail); setCode(""); setErr(""); setTimeout(() => input.current?.focus(), 30); }; window.addEventListener(EVENT, on); return () => window.removeEventListener(EVENT, on); }, []);
  const done = (ok) => { setOpen(null); const w = waiter; waiter = null; w?.(ok); };
  async function submit(e) {
    e.preventDefault(); if (busy || !open) return; setBusy(true); setErr("");
    try {
      const r = await fetch("/api/orgs/step-up", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId: open.orgId, code: code.trim() }) }); const j = await r.json().catch(() => ({}));
      if (r.ok) { done(true); return; }
      setErr(j.code === "MFA_NOT_ENROLLED" ? "You have no authenticator app set up yet. Set one up in your security settings, then try again." : j.error || "That did not work.");
    } catch { setErr("Could not reach the server. Try again."); } finally { setBusy(false); }
  }
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-label="Confirm it is you">
      <div className="fixed inset-0 bg-black/70" onClick={() => done(false)} />
      <form onSubmit={submit} className="relative w-full max-w-sm bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5">
        <h3 className="font-bold text-sm">Confirm it is you</h3>
        <p className="text-xs opacity-70 mt-1">Your organization requires stronger authentication for this action. Enter the 6-digit code from your authenticator app.</p>
        <input ref={input} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Authenticator code" className="w-full mt-3 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-lg tracking-[0.4em] text-center" placeholder="000000" />
        {err && <p className="text-xs text-amber-300 mt-2" role="alert">{err}</p>}
        <div className="flex gap-2 justify-end mt-3"><button type="button" className="text-xs px-3 py-1.5 rounded-lg border border-white/10" onClick={() => done(false)}>Cancel</button><button type="submit" disabled={busy || code.length !== 6} className="text-xs px-3 py-1.5 rounded-lg bg-[#00f2fe]/20 border border-[#00f2fe]/40 disabled:opacity-40">{busy ? "Checking…" : "Confirm"}</button></div>
      </form>
    </div>
  );
}
