"use client";

// app/business/page.js
//
// Business Records Management — Company -> Department -> Project ->
// Document, backed by /api/orgs/*. Deliberately a SEPARATE page from the
// main wallet-connected dApp (page.js): this feature's identity model is
// email + session cookie, not a wallet address, and mixing the two auth
// paradigms into one nav would be confusing for what's really a different
// product surface (a business/SaaS document system) that happens to reuse
// the same encrypt/shard/pin/on-chain-hash storage pipeline underneath.
//
// Document upload's encrypt/shard/pin pipeline lives in
// ../../lib/clientCrypto.js — shared with FinanceView/HRView, which do the
// exact same thing for receipts/employee documents. decryptData and
// fetchShardFromIPFS (below) stay local: they're this file's own, not
// duplicated anywhere else.
//
// LAYOUT: a fixed left sidebar (Dashboard/Departments/Projects/Documents/
// Approvals/Activity/Settings) + a scrollable content area, replacing the
// original single-column/tab layout. The Dashboard, Approvals, and
// Activity views are backed by two new aggregate routes
// (/api/orgs/dashboard, /api/orgs/activity) that resolve "everything this
// member can see across the whole org" in one call via
// getAccessibleScope() (document-permissions.js) — every number and list
// shown is real data through the same permission resolution the rest of
// the app already uses, nothing here is placeholder content.

import { useState, useEffect, useCallback, useRef } from "react";
import { PricingCard } from "./PricingCard";
import EmptyState from "../../components/EmptyState";
import AccentGraphic from "../../components/AccentGraphic";
import Skeleton from "../../components/Skeleton";
import WorkflowVisualization from "../../components/business/WorkflowVisualization";
import AIWidget from "../../components/business/AIWidget";
import TasksView from "../../components/business/TasksView";
import CRMView from "../../components/business/CRMView";
import ProcurementView from "../../components/business/ProcurementView";
import InventoryView from "../../components/business/InventoryView";
import FinanceView from "../../components/business/FinanceView";
import HRView from "../../components/business/HRView";
import InsightsView from "../../components/business/InsightsView";
import AIActionRequestsView from "../../components/business/AIActionRequestsView";
import { encryptAndShardFile } from "../../lib/clientCrypto";
import ConfirmButton from "../../components/business/ConfirmButton";

// Set by the public pricing page (business/pricing/page.js) before it
// redirects a not-yet-signed-in visitor here — see that file's header
// comment for why this is localStorage and not a query param.
const PENDING_PLAN_KEY = "inaya_pending_plan";

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

// ============================================================
// Client-side crypto + pinning — see module comment above.
// ============================================================
async function decryptData(base64Str, password) {
  const binaryStr = window.atob(base64Str);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) combined[i] = binaryStr.charCodeAt(i);
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const encrypted = combined.slice(28);
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

// Same two-gateway fallback the wallet-connected flow uses (page.js) —
// Cloudflare's IPFS gateway first, Pinata's as a fallback.
async function fetchShardFromIPFS(cid) {
  try {
    const res = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`);
    const json = await res.json();
    return json.shard;
  } catch {
    const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
    const json = await res.json();
    return json.shard;
  }
}

// ============================================================
async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function BusinessPage() {
  const [sessionLoading, setSessionLoading] = useState(true);
  const [session, setSession] = useState(null); // { email, orgs: [{orgId, orgName, role, departmentIds}] }
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [notice, setNotice] = useState("");

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch("/api/orgs/session");
      if (res.status === 401) {
        setSession(null);
        return;
      }
      const data = await res.json();
      setSession(data);
      setSelectedOrgId((prev) => prev || data.orgs?.[0]?.orgId || null);
    } catch {
      setSession(null);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("orgLoggedIn")) setNotice("Signed in.");
    if (params.get("orgLoginError")) setNotice("That sign-in link is invalid or has expired — request a new one below.");
    if (params.get("orgLoggedIn") || params.get("orgLoginError")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    refreshSession();
  }, [refreshSession]);

  // DAU/WAU activity ping — fire-and-forget, once per confirmed session.
  // Identity is the session email (always authenticated here, no
  // anonymous case for Business Workspace).
  useEffect(() => {
    if (!session?.email) return;
    fetch('/api/activity/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface: 'business', identityId: session.email }),
    }).catch(() => {});
  }, [session?.email]);

  // A visitor who picked a plan on the public pricing page while signed
  // out lands back here post-auth with the choice stashed in localStorage
  // (see PricingPage's header comment) — fire that checkout automatically
  // instead of making them find and re-click "Change plan" themselves.
  useEffect(() => {
    if (!session?.authenticated) return;
    const raw = localStorage.getItem(PENDING_PLAN_KEY);
    if (!raw) return;
    localStorage.removeItem(PENDING_PLAN_KEY);

    let pending;
    try {
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    if (!pending?.planId) return;

    const membership = session.orgs.find((o) => o.orgId === selectedOrgId) || session.orgs[0];
    if (!membership) return;
    if (membership.role !== "owner" && membership.role !== "admin") {
      setNotice("Ask your company's owner or admin to upgrade the plan.");
      return;
    }

    api("/api/orgs/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ orgId: membership.orgId, planId: pending.planId, interval: pending.interval || "month" }),
    })
      .then((data) => {
        window.location.href = data.url;
      })
      .catch((err) => setNotice(err.message));
  }, [session, selectedOrgId]);

  async function handleLogout() {
    await api("/api/orgs/logout", { method: "POST" });
    setSession(null);
    setSelectedOrgId(null);
  }

  if (sessionLoading) {
    return (
      <CenteredShell>
        <p className="text-[#94a3b8] font-mono text-sm">Loading…</p>
      </CenteredShell>
    );
  }

  if (!session?.authenticated) {
    return (
      <CenteredShell>
        <AuthScreen notice={notice} onAuthed={refreshSession} />
      </CenteredShell>
    );
  }

  // Only reachable via Google sign-in — magic-link logins always come from
  // an existing member or an invite, so they can never land here with zero
  // memberships. A brand-new Google identity can, though.
  if (session.orgs.length === 0) {
    return (
      <CenteredShell>
        <CreateCompanyPrompt email={session.email} onCreated={refreshSession} onLogout={handleLogout} />
      </CenteredShell>
    );
  }

  const currentMembership = session.orgs.find((o) => o.orgId === selectedOrgId) || session.orgs[0];

  const needsPlanSelection = currentMembership?.requiresPlanSelection && !currentMembership?.plan;

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans">
      {currentMembership && needsPlanSelection && (
        <PlanSelectionGate email={session.email} membership={currentMembership} onLogout={handleLogout} />
      )}
      {currentMembership && !needsPlanSelection && (
        <Workspace
          key={currentMembership.orgId}
          email={session.email}
          membership={currentMembership}
          orgs={session.orgs}
          selectedOrgId={currentMembership.orgId}
          onSwitchOrg={setSelectedOrgId}
          onLogout={handleLogout}
        />
      )}
    </div>
  );
}

// ============================================================
// PLAN SELECTION GATE — shown instead of the Dashboard for a newly
// created company (orgs/create/route.js sets requiresPlanSelection:true
// going forward) until its owner picks a plan or starts its free trial.
// Pre-existing orgs never have this field set, so they're unaffected —
// see that route's comment for why new vs. legacy orgs are treated
// differently here.
// ============================================================
function PlanSelectionGate({ email, membership, onLogout }) {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState("");
  const [switchingPlanId, setSwitchingPlanId] = useState(null);
  const [checkingActivation, setCheckingActivation] = useState(false);

  useEffect(() => {
    fetch("/api/orgs/billing/plans")
      .then((res) => res.json())
      .then((data) => setPlans(data.plans))
      .catch(() => setError("Could not load plans."));
  }, []);

  // Stripe's redirect back here can beat the webhook that actually writes
  // the plan — poll briefly instead of just re-showing this same gate as
  // if the checkout the user just completed did nothing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") !== "success") return;
    window.history.replaceState({}, "", window.location.pathname);
    setCheckingActivation(true);

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch("/api/orgs/session");
        const data = await res.json();
        const org = data.orgs?.find((o) => o.orgId === membership.orgId);
        if (org?.plan) {
          window.location.reload(); // simplest way for BusinessPage to re-derive membership and drop the gate
          return;
        }
      } catch {
        // keep polling — a transient failure here shouldn't stop retrying
      }
      if (attempts >= 8) {
        clearInterval(interval);
        setCheckingActivation(false);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [membership.orgId]);

  async function handleSelect(plan) {
    if (plan.contactSalesOnly) {
      window.location.href = "mailto:sales@inaya.ai?subject=Inaya%20Business%20Workspace%20—%20Enterprise";
      return;
    }
    setSwitchingPlanId(plan.id);
    setError("");
    try {
      const d = await api("/api/orgs/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ orgId: membership.orgId, planId: plan.id, interval: "month" }),
      });
      window.location.href = d.url;
    } catch (err) {
      setError(err.message);
      setSwitchingPlanId(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-4 mb-8 flex-wrap">
          <div>
            <p className="text-[#94a3b8] text-xs font-mono">{email} · {membership.orgName}</p>
            <h1 className="text-2xl font-extrabold text-white mt-1">Activate your workspace</h1>
            <p className="text-[#94a3b8] text-sm mt-1 max-w-xl">
              Pick a plan to get started. Every plan includes a 14-day free trial — and since this runs on Inaya's testnet, nothing is actually charged during the trial.
            </p>
          </div>
          <button onClick={onLogout} className="text-[12px] font-bold uppercase bg-white/5 border border-white/10 px-3 py-2 rounded-lg text-slate-300 hover:bg-white/10 shrink-0">
            Sign out
          </button>
        </div>

        <div className="bg-amber-400/10 border border-amber-400/40 rounded-xl px-4 py-2.5 flex items-center gap-2 mb-6">
          <span className="text-amber-400 text-sm">⚠️</span>
          <p className="text-[12px] text-amber-300 font-bold font-mono">
            TEST MODE — Stripe checkout won't accept a real card. Use 4242 4242 4242 4242, any future expiry, any CVC/ZIP.
          </p>
        </div>

        {checkingActivation && (
          <div className="bg-[#00f2fe]/10 border border-[#00f2fe]/20 text-[#00f2fe] text-xs rounded-lg p-3 mb-6">
            Activating your plan — this can take a few seconds after checkout…
          </div>
        )}
        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
        {!plans && !error && <p className="text-[#94a3b8] text-sm">Loading plans…</p>}

        {plans && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {plans.map((plan) => (
              <PricingCard key={plan.id} plan={plan} loading={switchingPlanId === plan.id} onSelect={() => handleSelect(plan)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CenteredShell({ children }) {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10 relative overflow-hidden">
      {/* Ambient glow -- purely decorative, matches the dashboard promo banner's
          cyan/violet gradient so the sign-in screen doesn't read as a flat,
          separate product from the rest of the workspace. */}
      <div className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[640px] h-[640px] rounded-full bg-gradient-to-br from-[#00f2fe]/10 via-violet-500/10 to-transparent blur-3xl" aria-hidden="true" />
      <div className="max-w-6xl mx-auto relative">{children}</div>
    </div>
  );
}

// ============================================================
// AUTH SCREEN
// ============================================================
function AuthScreen({ notice, onAuthed }) {
  const [mode, setMode] = useState("signin"); // 'signin' | 'create'
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");
  const [googleError, setGoogleError] = useState("");
  const googleButtonRef = useRef(null);

  // Google Identity Services renders its own button into this ref via a
  // dynamically-loaded script — kept optional (silently absent) when
  // NEXT_PUBLIC_GOOGLE_CLIENT_ID isn't configured, rather than a hard
  // dependency every deployment must set up.
  const handleGoogleCredential = useCallback(
    async (response) => {
      setGoogleError("");
      try {
        await api("/api/orgs/login/google", { method: "POST", body: JSON.stringify({ idToken: response.credential }) });
        onAuthed();
      } catch (err) {
        setGoogleError(err.message);
      }
    },
    [onAuthed]
  );

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || !googleButtonRef.current) return;

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      if (!window.google || !googleButtonRef.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "filled_black",
        size: "large",
        width: 336,
        text: "continue_with",
      });
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [handleGoogleCredential]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    setFallbackUrl("");
    try {
      if (mode === "create") {
        const data = await api("/api/orgs/create", { method: "POST", body: JSON.stringify({ orgName, ownerEmail: email }) });
        setMessage(data.emailSent ? "Company created — check your email for a sign-in link." : "Company created.");
        if (data.loginUrl) setFallbackUrl(data.loginUrl);
      } else {
        const data = await api("/api/orgs/login/request", { method: "POST", body: JSON.stringify({ email }) });
        setMessage("If that email has an account, a sign-in link is on its way — check your inbox.");
        if (data.loginUrl) setFallbackUrl(data.loginUrl);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-8 md:mt-16 grid md:grid-cols-2 gap-10 md:gap-16 items-center">
      {/* LEFT — the actual sign-in form */}
      <div className="max-w-md md:mx-0 mx-auto w-full inaya-fade-in-up">
        <a href="/" className="inline-block text-[#94a3b8] hover:text-slate-300 text-xs font-mono mb-8">← Inaya Network</a>
        <h1 className="text-2xl font-extrabold text-white mb-1">Business Records</h1>
        <p className="text-[#94a3b8] text-sm mb-8">Encrypted document management for your company, built on Inaya's storage infrastructure.</p>

        {notice && <div className="bg-amber-400/10 border border-amber-400/20 text-amber-300 text-xs rounded-lg p-3 mb-4">{notice}</div>}

        <div className="flex bg-[#090d16] border border-white/5 rounded-xl p-1 mb-6">
          <button onClick={() => setMode("signin")} className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg ${mode === "signin" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#94a3b8]"}`}>Sign in</button>
          <button onClick={() => setMode("create")} className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg ${mode === "create" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#94a3b8]"}`}>Create a company</button>
        </div>

        <div ref={googleButtonRef} className="flex justify-center mb-2" />
        {googleError && <p className="text-red-400 text-xs text-center mb-3">{googleError}</p>}
        {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && (
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-[12px] text-[#8a96ab] uppercase font-bold">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "create" && (
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required placeholder="Company name" className="w-full bg-black/45 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]" />
          )}
          <input value={email} onChange={(e) => setEmail(e.target.value)} required type="email" placeholder="you@company.com" className="w-full bg-black/45 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]" />
          <button disabled={submitting} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {submitting ? "Working…" : mode === "create" ? "Create company" : "Send sign-in link"}
          </button>
        </form>

        {error && <p className="text-red-400 text-xs mt-4">{error}</p>}
        {message && <p className="text-emerald-400 text-xs mt-4">{message}</p>}
        {fallbackUrl && (
          <div className="mt-3 bg-black/20 border border-white/10 rounded-xl p-4">
            <p className="text-slate-400 text-xs mb-2">Email delivery isn't fully set up yet — use this link directly:</p>
            <a href={fallbackUrl} className="text-[#00f2fe] underline text-xs break-all">{fallbackUrl}</a>
          </div>
        )}

        <a
          href="/docs/business-workspace-guide.md"
          download
          className="mt-8 flex items-center justify-center gap-2 text-xs text-[#94a3b8] hover:text-[#00f2fe] border border-white/10 hover:border-[#00f2fe]/30 rounded-xl py-2.5"
        >
          <span aria-hidden>↓</span> Download the step-by-step setup guide
        </a>
        <a
          href="/business/download"
          className="mt-2 flex items-center justify-center gap-2 text-xs text-[#94a3b8] hover:text-[#00f2fe] border border-white/10 hover:border-[#00f2fe]/30 rounded-xl py-2.5"
        >
          <span aria-hidden>🖥️</span> Get the Desktop App (Windows / Linux)
        </a>
      </div>

      {/* RIGHT — visual panel, hidden below md. Grounded in the real data model
          (Company -> Department -> Project -> Document, see this file's top
          comment) rather than generic decoration. */}
      <div className="hidden md:flex flex-col items-center text-center inaya-fade-in-up" style={{ animationDelay: "0.15s" }}>
        <AccentGraphic variant="business" size={180} />
        <div className="mt-8 space-y-5 max-w-xs">
          {[
            { icon: "🔒", title: "Client-side encrypted", desc: "Files are encrypted and sharded before they ever leave the browser." },
            { icon: "🗂️", title: "Company → Department → Project → Document", desc: "The same structure your org already thinks in — nothing to relearn." },
            { icon: "✅", title: "Built-in approvals", desc: "Review and sign off on documents without leaving the workspace." },
          ].map((f) => (
            <div key={f.title} className="flex items-start gap-3 text-left">
              <span className="text-xl shrink-0" aria-hidden>{f.icon}</span>
              <div>
                <p className="text-white text-sm font-bold leading-tight">{f.title}</p>
                <p className="text-[#94a3b8] text-xs mt-0.5">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CREATE COMPANY PROMPT — shown when a session is authenticated but has
// zero org memberships. Only reachable via Google sign-in today (see the
// comment where this is rendered in BusinessPage) — the caller's identity
// is already verified by the existing session, so this just needs a
// company name; /api/orgs/create infers ownerEmail from the session and
// skips its usual magic-link round trip.
// ============================================================
function CreateCompanyPrompt({ email, onCreated, onLogout }) {
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/create", { method: "POST", body: JSON.stringify({ orgName }) });
      onCreated();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-16">
      <div className="flex items-center justify-between mb-8">
        <p className="text-[#94a3b8] text-xs font-mono truncate">{email}</p>
        <button onClick={onLogout} className="text-[12px] font-bold uppercase text-[#94a3b8] hover:text-slate-300 shrink-0 ml-2">
          Sign out
        </button>
      </div>
      <h1 className="text-2xl font-extrabold text-white text-center mb-1">Name your company</h1>
      <p className="text-[#94a3b8] text-sm text-center mb-8">You're signed in but not part of any company yet — create one to get started.</p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          required
          placeholder="Company name"
          className="w-full bg-black/45 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]"
        />
        <button disabled={submitting} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
          {submitting ? "Creating…" : "Create company"}
        </button>
      </form>

      {error && <p className="text-red-400 text-xs mt-4">{error}</p>}
    </div>
  );
}

// ============================================================
// ICONS — small inline SVGs, no icon library dependency in this app.
// ============================================================
function Icon({ path, className = "w-[18px] h-[18px]" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  );
}

const ICONS = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  departments: (
    <>
      <rect x="4" y="3" width="12" height="18" rx="1" />
      <path d="M8 7h1M11 7h1M8 11h1M11 11h1M8 15h1M11 15h1" />
      <path d="M16 21v-7h4v7" />
    </>
  ),
  projects: <path d="M3 7a1 1 0 0 1 1-1h4l2 2h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
  documents: (
    <>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
      <rect x="9.5" y="13" width="5" height="4" rx="1" />
      <path d="M10.5 13v-1.5a1.5 1.5 0 0 1 3 0V13" />
    </>
  ),
  approvals: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </>
  ),
  tasks: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M7.5 9l1.8 1.8L12.5 7.5" />
      <path d="M15 8.5h4" />
      <path d="M7.5 16h9" />
    </>
  ),
  crm: (
    <>
      <circle cx="9" cy="7.5" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16.5 8.5a2.5 2.5 0 1 0 0-5" />
      <path d="M15.5 15c3.5 0 5 2 5 5" />
    </>
  ),
  procurement: (
    <>
      <path d="M3 7l2-4h14l2 4" />
      <path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
      <path d="M8 11a4 4 0 0 0 8 0" />
    </>
  ),
  inventory: (
    <>
      <path d="M3 8l9-5 9 5-9 5-9-5Z" />
      <path d="M3 8v9l9 5 9-5V8" />
      <path d="M12 13v9" />
    </>
  ),
  activity: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  aiAssistant: (
    <>
      <path d="M12 3a1 1 0 0 1 1 1v1.06a7.5 7.5 0 0 1 6.94 6.94H21a1 1 0 0 1 0 2h-1.06a7.5 7.5 0 0 1-6.94 6.94V22a1 1 0 0 1-2 0v-1.06a7.5 7.5 0 0 1-6.94-6.94H3a1 1 0 0 1 0-2h1.06A7.5 7.5 0 0 1 11 5.06V4a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  send: <path d="M4 12l16-8-6 8 6 8-16-8Z" />,
  logout: (
    <>
      <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  chevronRight: <path d="M9 18l6-6-6-6" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  billing: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19" />
      <path d="M6 15h4" />
    </>
  ),
  finance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M15 9.5a3 3 0 0 0-3-1.5c-1.7 0-3 1-3 2.2 0 3 6 1.5 6 4.3 0 1.2-1.3 2.2-3 2.2a3 3 0 0 1-3-1.5" />
    </>
  ),
  hr: (
    <>
      <circle cx="8.5" cy="7.5" r="3.2" />
      <path d="M2.5 20.5a6 6 0 0 1 12 0" />
      <path d="M16 4.5a3.2 3.2 0 0 1 0 6.4" />
      <path d="M14.5 14.5c2.8 0 5 1.9 5.5 4.6" />
      <path d="M18.5 8.5v3M17 10h3" />
    </>
  ),
  insights: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 15l3-4 3 2.5L17 8" />
      <circle cx="17" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
};

// The gear icon's cutout path above is fiddly to hand-write cleanly; use a
// simpler bolt-free cog approximation instead so it actually renders well
// at 18px.
ICONS.settings = (
  <>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7L16 16M8 8 6.3 6.3" />
  </>
);

// ============================================================
// SIDEBAR + WORKSPACE SHELL
// ============================================================
const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard" },
  { key: "insights", label: "Insights", icon: "insights" },
  { key: "departments", label: "Departments", icon: "departments" },
  { key: "projects", label: "Projects", icon: "projects" },
  { key: "documents", label: "Documents", icon: "documents" },
  { key: "tasks", label: "Tasks", icon: "tasks" },
  { key: "crm", label: "CRM", icon: "crm" },
  { key: "procurement", label: "Procurement", icon: "procurement" },
  { key: "inventory", label: "Inventory", icon: "inventory" },
  { key: "finance", label: "Finance", icon: "finance" },
  { key: "hr", label: "HR", icon: "hr" },
  { key: "approvals", label: "Approvals", icon: "approvals", manageOnly: true },
  { key: "aiActions", label: "AI Action Requests", icon: "aiAssistant" },
  { key: "activity", label: "Activity", icon: "activity" },
  { key: "ai", label: "AI Assistant", icon: "aiAssistant" },
  { key: "billing", label: "Billing", icon: "billing", manageOnly: true },
  { key: "settings", label: "Settings", icon: "settings", manageOnly: true },
];

function Sidebar({ orgName, role, activeView, onNavigate, canManage, mobileOpen, onCloseMobile }) {
  return (
    <>
      {mobileOpen && <div onClick={onCloseMobile} className="fixed inset-0 bg-black/60 z-40 md:hidden" />}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 w-64 shrink-0 bg-[#090d16] border-r border-white/5 flex flex-col transition-transform duration-200 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="px-5 py-6 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
              <span className="text-black font-extrabold text-sm">I</span>
            </div>
            <div className="min-w-0">
              <p className="text-white font-extrabold text-sm leading-tight truncate">Inaya Network</p>
              <p className="text-[#94a3b8] text-[12px] font-mono uppercase tracking-wide">Business Workspace</p>
            </div>
          </div>
          <div className="mt-4 bg-black/30 border border-white/5 rounded-lg px-3 py-2">
            <p className="text-slate-200 text-xs font-bold truncate">{orgName}</p>
            <p className="text-[#00f2fe] text-[12px] font-mono uppercase tracking-wide mt-0.5">{ROLE_LABELS[role] || role}</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.filter((item) => !item.manageOnly || canManage).map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activeView === item.key ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-[#94a3b8] hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              <Icon path={ICONS[item.icon]} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="px-3 pb-5">
          <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-emerald-400/5 border border-emerald-400/15">
            <Icon path={ICONS.lock} className="w-4 h-4 text-emerald-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-emerald-300 text-[12px] font-bold uppercase tracking-wide">End-to-end encrypted</p>
              <p className="text-[#94a3b8] text-[11px] font-mono">AES-256 · client-side</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function Workspace({ email, membership, orgs, selectedOrgId, onSwitchOrg, onLogout }) {
  const { orgId, role, departmentIds } = membership;
  const canManage = role === "owner" || role === "admin";

  const [activeView, setActiveView] = useState("dashboard");
  const [browseTarget, setBrowseTarget] = useState(null); // { deptId, projectId } — set when navigating in from Dashboard
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  function navigate(view, target) {
    setActiveView(view === "departments" || view === "projects" || view === "documents" ? "browse" : view);
    setBrowseTarget(target || null);
    setMobileNavOpen(false);
  }

  const VIEW_TITLES = {
    dashboard: "Overview",
    insights: "Business Insights",
    browse: "Company Records",
    tasks: "Tasks",
    crm: "CRM",
    procurement: "Procurement",
    inventory: "Inventory",
    finance: "Finance",
    hr: "HR",
    approvals: "Approvals",
    aiActions: "AI Action Requests",
    activity: "Activity",
    ai: "AI Assistant",
    billing: "Billing",
    settings: "Settings",
  };

  return (
    <div className="flex min-h-screen">
      <div className="pointer-events-none fixed top-0 right-0 w-[36rem] h-[36rem] rounded-full bg-gradient-to-br from-[#00f2fe]/5 via-violet-500/5 to-transparent blur-3xl -z-10" aria-hidden="true" />
      {/* Hidden on the dedicated AI Assistant tab itself -- showing the
          floating bubble/panel on top of that full page would be redundant. */}
      {activeView !== "ai" && <AIWidget orgId={orgId} />}
      <Sidebar
        orgName={membership.orgName}
        role={role}
        activeView={activeView}
        onNavigate={navigate}
        canManage={canManage}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-[#060913]/90 backdrop-blur border-b border-white/5 px-5 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => setMobileNavOpen(true)} className="md:hidden text-slate-300 p-1">
              <Icon path={<path d="M4 6h16M4 12h16M4 18h16" />} />
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold text-white tracking-tight truncate">{VIEW_TITLES[activeView]}</h1>
              <p className="text-[#94a3b8] text-[13px] font-mono truncate">{email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/docs/business-workspace-guide.md"
              download
              className="hidden sm:inline-block text-[12px] font-bold uppercase text-[#94a3b8] hover:text-slate-300 px-2 py-2"
              title="Download the step-by-step setup guide"
            >
              ↓ Guide
            </a>
            <a
              href="/business/download"
              className="hidden sm:inline-block text-[12px] font-bold uppercase text-[#94a3b8] hover:text-slate-300 px-2 py-2"
              title="Get the Business Workspace desktop app"
            >
              🖥️ Desktop App
            </a>
            <a
              href="/"
              className="hidden sm:inline-block text-[12px] font-bold uppercase text-[#94a3b8] hover:text-slate-300 px-2 py-2"
              title="Back to the Inaya Network dApp"
            >
              ← dApp
            </a>
            {orgs.length > 1 && (
              <select
                value={selectedOrgId || ""}
                onChange={(e) => onSwitchOrg(e.target.value)}
                className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-white"
              >
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>{o.orgName}</option>
                ))}
              </select>
            )}
            <button onClick={onLogout} className="text-[12px] font-bold uppercase bg-white/5 border border-white/10 px-3 py-2 rounded-lg text-slate-300 hover:bg-white/10">
              Sign out
            </button>
          </div>
        </header>

        <main className="p-5 md:p-8 max-w-6xl">
          {activeView === "dashboard" && (
            <DashboardView orgId={orgId} canManage={canManage} onNavigate={navigate} />
          )}
          {activeView === "insights" && <InsightsView orgId={orgId} canManage={canManage} onNavigate={navigate} />}
          {activeView === "browse" && (
            <OrgWorkspace
              key={`${browseTarget?.deptId || ""}:${browseTarget?.projectId || ""}`}
              orgId={orgId}
              departmentIds={departmentIds}
              canManage={canManage}
              initialDeptId={browseTarget?.deptId || null}
              initialProjectId={browseTarget?.projectId || null}
            />
          )}
          {activeView === "tasks" && <TasksView orgId={orgId} canManage={canManage} email={email} />}
          {activeView === "crm" && <CRMView orgId={orgId} canManage={canManage} email={email} />}
          {activeView === "procurement" && <ProcurementView orgId={orgId} canManage={canManage} />}
          {activeView === "inventory" && <InventoryView orgId={orgId} />}
          {activeView === "finance" && <FinanceView orgId={orgId} email={email} />}
          {activeView === "hr" && <HRView orgId={orgId} email={email} />}
          {activeView === "approvals" && canManage && <ApprovalsView orgId={orgId} onNavigate={navigate} />}
          {activeView === "aiActions" && <AIActionRequestsView orgId={orgId} />}
          {activeView === "activity" && <ActivityView orgId={orgId} />}
          {activeView === "ai" && <AIAssistantView orgId={orgId} />}
          {activeView === "billing" && canManage && <BillingView orgId={orgId} canManage={canManage} />}
          {activeView === "settings" && canManage && <TeamView orgId={orgId} email={email} />}
        </main>
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD — overview cards + recent departments/projects/documents.
// ============================================================
const STATUS_STYLES = {
  DRAFT: "bg-white/5 text-[#94a3b8] border-white/10",
  PENDING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  UNDER_REVIEW: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  ARCHIVED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

function StatCard({ icon, label, value, sub }) {
  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 flex items-center gap-4">
      <div className="w-11 h-11 rounded-xl bg-[#00f2fe]/10 flex items-center justify-center shrink-0">
        <Icon path={ICONS[icon]} className="w-5 h-5 text-[#00f2fe]" />
      </div>
      <div className="min-w-0">
        <p className="text-[#94a3b8] text-[12px] font-bold uppercase tracking-wide">{label}</p>
        <p className="text-white text-2xl font-extrabold leading-tight">{value}</p>
        {sub && <p className="text-[#94a3b8] text-[12px] font-mono">{sub}</p>}
      </div>
    </div>
  );
}

function DashboardCard({ title, onViewAll, children }) {
  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8]">{title}</h3>
        {onViewAll && (
          <button onClick={onViewAll} className="text-[12px] font-bold text-[#00f2fe] flex items-center gap-0.5">
            View all <Icon path={ICONS.chevronRight} className="w-3 h-3" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function DashboardView({ orgId, canManage, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/dashboard?orgId=${orgId}`);
      setData(result);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <Skeleton count={3} borderColors={["border-[#00f2fe]", "border-violet-400", "border-[#00f2fe]"]} />;

  const isDesktopApp = typeof window !== "undefined" && !!window.__TAURI__;

  return (
    <div className="space-y-6">
      {/* Desktop app cross-promotion -- hidden when already running inside
          the desktop app itself, same reasoning as not showing "Explore"
          for a product you're already in. */}
      {!isDesktopApp && (
        <div className="relative overflow-hidden bg-gradient-to-r from-[#00f2fe]/10 via-[#090d16] to-violet-500/10 border border-white/10 rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 inaya-fade-in-up">
          <div className="pointer-events-none absolute -right-6 -top-6 opacity-40 hidden sm:block" aria-hidden="true">
            <AccentGraphic variant="business" size={120} />
          </div>
          <div className="relative">
            <span className="inline-block text-[12px] font-bold uppercase tracking-wide text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 rounded-full px-2.5 py-1 mb-2">
              New · Desktop App
            </span>
            <h3 className="text-white font-extrabold text-base sm:text-lg">🖥️ Business Workspace, now on your desktop</h3>
            <p className="text-[#94a3b8] text-xs sm:text-sm mt-1 max-w-lg">
              Runs in your system tray, notifies you when something needs your approval, and updates itself. Available for Windows and Linux.
            </p>
          </div>
          <div className="relative flex gap-2 shrink-0 w-full sm:w-auto">
            <a
              href="/business/download"
              className="flex-1 sm:flex-none text-center text-xs font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-violet-400 px-4 py-2.5 rounded-lg hover:brightness-110"
            >
              Download
            </a>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="inaya-fade-in-up" style={{ animationDelay: "0.05s" }}>
          <StatCard icon="departments" label="Departments" value={data.counts.departments} sub="Active departments" />
        </div>
        <div className="inaya-fade-in-up" style={{ animationDelay: "0.1s" }}>
          <StatCard icon="projects" label="Projects" value={data.counts.projects} sub="Active projects" />
        </div>
        <div className="inaya-fade-in-up" style={{ animationDelay: "0.15s" }}>
          <StatCard icon="documents" label="Documents" value={data.counts.documents} sub="Encrypted & secured" />
        </div>
      </div>

      {canManage && data.pendingApprovals.length > 0 && (
        <DashboardCard title={`Pending your approval (${data.pendingApprovals.length})`} onViewAll={() => onNavigate("approvals")}>
          <div className="space-y-1">
            {data.pendingApprovals.slice(0, 4).map((d) => (
              <button
                key={d.id}
                onClick={() => onNavigate("documents", { deptId: d.departmentId, projectId: d.projectId })}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-white/5 text-left"
              >
                <span className="text-slate-300 text-xs truncate">{d.filename}</span>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLES[d.status]}`}>{d.status.replace("_", " ")}</span>
              </button>
            ))}
          </div>
        </DashboardCard>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DashboardCard title="Recent Departments" onViewAll={() => onNavigate("departments")}>
          {data.recentDepartments.length === 0 ? (
            <EmptyState compact icon="🏢" description="No departments yet." ctaLabel="Create one" onCta={() => onNavigate("departments")} />
          ) : (
            <div className="space-y-1">
              {data.recentDepartments.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onNavigate("projects", { deptId: d.id })}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-left"
                >
                  <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                    <Icon path={ICONS.departments} className="w-4 h-4 text-[#94a3b8]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-slate-200 text-xs font-bold truncate">{d.name}</p>
                    <p className="text-[#94a3b8] text-[12px] font-mono">{d.projectCount} project{d.projectCount === 1 ? "" : "s"}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </DashboardCard>

        <DashboardCard title="Recent Projects" onViewAll={() => onNavigate("projects")}>
          {data.recentProjects.length === 0 ? (
            <EmptyState compact icon="📁" description="No projects yet." ctaLabel="Create one" onCta={() => onNavigate("projects")} />
          ) : (
            <div className="space-y-1">
              {data.recentProjects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onNavigate("documents", { deptId: p.departmentId, projectId: p.id })}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg hover:bg-white/5 text-left"
                >
                  <div className="min-w-0">
                    <p className="text-slate-200 text-xs font-bold truncate">{p.name}</p>
                    <p className="text-[#94a3b8] text-[12px] font-mono truncate">{p.departmentName} · {p.documentCount} document{p.documentCount === 1 ? "" : "s"}</p>
                  </div>
                  <span className="flex items-center gap-1 text-[11px] font-bold uppercase text-emerald-400 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Active
                  </span>
                </button>
              ))}
            </div>
          )}
        </DashboardCard>
      </div>

      <DashboardCard title="Encrypted Documents" onViewAll={() => onNavigate("documents")}>
        {data.recentDocuments.length === 0 ? (
          <EmptyState compact icon="🔐" description="No documents yet." ctaLabel="Upload one" onCta={() => onNavigate("documents")} />
        ) : (
          <div className="space-y-1">
            {data.recentDocuments.map((d) => (
              <button
                key={d.id}
                onClick={() => onNavigate("documents", { deptId: d.departmentId, projectId: d.projectId })}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                  <Icon path={ICONS.documents} className="w-4 h-4 text-[#94a3b8]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-slate-200 text-xs font-bold truncate">{d.filename}</p>
                  <p className="text-[#94a3b8] text-[12px] font-mono truncate">{d.departmentName} · {d.projectName}</p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[d.status] || STATUS_STYLES.DRAFT}`}>
                    {d.status.replace("_", " ")}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400">
                    <Icon path={ICONS.lock} className="w-2.5 h-2.5" /> Encrypted
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </DashboardCard>
    </div>
  );
}

// ============================================================
// APPROVALS — pending/under-review documents this manager can act on.
// ============================================================
function ApprovalsView({ orgId, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/dashboard?orgId=${orgId}`);
      setData(result.pendingApprovals);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(docId, action) {
    setActing(docId + action);
    setError("");
    try {
      await api(`/api/orgs/documents/${docId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  function toggleSelected(docId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  async function handleApproveSelected() {
    setBulkApproving(true);
    setError("");
    try {
      for (const docId of selected) {
        await api(`/api/orgs/documents/${docId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action: "approve" }) });
      }
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkApproving(false);
    }
  }

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[#94a3b8] font-mono text-sm">Loading…</p>;

  const selectableIds = data.filter((d) => d.status === "UNDER_REVIEW").map((d) => d.id);

  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8]">Documents awaiting your review</h3>
        {selected.size > 0 && (
          <button
            onClick={handleApproveSelected}
            disabled={bulkApproving}
            className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40"
          >
            {bulkApproving ? "Approving…" : `Approve selected (${selected.size})`}
          </button>
        )}
      </div>
      {data.length === 0 ? (
        <EmptyState compact icon="✅" description="Nothing needs your attention right now — you're all caught up." />
      ) : (
        <div className="space-y-2">
          {data.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
              <div className="flex items-center gap-2 min-w-0">
                {d.status === "UNDER_REVIEW" && (
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelected(d.id)} className="shrink-0" />
                )}
                <button onClick={() => onNavigate("documents", { deptId: d.departmentId, projectId: d.projectId })} className="min-w-0 text-left">
                  <p className="text-white text-sm truncate">{d.filename}</p>
                  <p className="text-[#94a3b8] text-[12px] font-mono">{d.departmentName} · {d.projectName}</p>
                </button>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[d.status]}`}>{d.status.replace("_", " ")}</span>
                {d.status === "PENDING" && (
                  <button
                    onClick={() => handleAction(d.id, "startReview")}
                    disabled={!!acting}
                    className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40"
                  >
                    {acting === d.id + "startReview" ? "…" : "Start review"}
                  </button>
                )}
                {d.status === "UNDER_REVIEW" && (
                  <>
                    <button
                      onClick={() => handleAction(d.id, "approve")}
                      disabled={!!acting}
                      className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40"
                    >
                      {acting === d.id + "approve" ? "…" : "Approve"}
                    </button>
                    <ConfirmButton
                      onConfirm={() => handleAction(d.id, "reject")}
                      disabled={!!acting}
                      className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40"
                    >
                      {acting === d.id + "reject" ? "…" : "Reject"}
                    </ConfirmButton>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
    </div>
  );
}

// ============================================================
// ACTIVITY — org-wide feed across every document the caller can see.
// ============================================================
const ACTIVITY_FEED_CAP = 100;

function ActivityView({ orgId }) {
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/activity?orgId=${orgId}`)
      .then((data) => setActivity(data.activity))
      .catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!activity) return <p className="text-[#94a3b8] font-mono text-sm">Loading…</p>;

  const capped = activity.slice(0, ACTIVITY_FEED_CAP);

  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8] mb-4">Recent activity</h3>
      {activity.length === 0 ? (
        <EmptyState compact icon="📜" description="No activity recorded yet — actions on documents in this org will show up here." />
      ) : (
        <div className="space-y-2.5">
          {activity.length > ACTIVITY_FEED_CAP && <p className="text-[11px] font-mono text-[#8a96ab]">Showing latest {ACTIVITY_FEED_CAP} of {activity.length}.</p>}
          {capped.map((e) => (
            <div key={e.eventId} className="text-xs border-b border-white/5 pb-2.5 last:border-0 last:pb-0">
              <span className="text-slate-200 font-bold">{e.filename}</span>
              <span className="text-[#94a3b8]"> · {e.action}</span>
              {e.previousState && <span className="text-[#94a3b8] font-mono"> · {e.previousState} → {e.newState}</span>}
              <div className="text-[12px] font-mono text-[#8a96ab] mt-0.5">
                {e.actorId} · {new Date(e.timestamp).toLocaleString()}
                {e.metadata?.note && <span className="italic"> — "{e.metadata.note}"</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// AI ASSISTANT — natural-language questions over this org's departments/
// projects/documents/activity. Every answer comes from
// POST /api/ai/business-chat, which runs Gemini function-calling against
// tools that are themselves permission-scoped server-side
// (lib/ai-business-tools.js) — this component has no say in what the
// assistant can see, it only renders the conversation.
// ============================================================
const AI_SUGGESTIONS = [
  "Which documents are waiting for approval?",
  "Show me the latest rejected documents.",
  "Which projects currently have pending documents?",
  "Show me our recently approved documents.",
];

function AIAssistantView({ orgId }) {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi — ask me about your company's departments, projects, documents, or recent activity. I only show you what you're already allowed to see." },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function send(text) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || sending) return;
    const nextMessages = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);
    setError("");
    try {
      const data = await api("/api/ai/business-chat", { method: "POST", body: JSON.stringify({ orgId, messages: nextMessages }) });
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 flex flex-col" style={{ height: "calc(100vh - 180px)", minHeight: 420 }}>
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                m.role === "user" ? "bg-[#00f2fe]/15 text-white" : "bg-white/5 text-slate-200"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-white/5 text-[#94a3b8] rounded-2xl px-4 py-2.5 text-sm italic">Thinking…</div>
          </div>
        )}
      </div>

      {messages.length <= 1 && (
        <div className="flex flex-wrap gap-2 py-3 border-t border-white/5 mt-3">
          {AI_SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(s)} className="text-[12px] text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5">
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about your company's documents, approvals, or activity…"
          disabled={sending}
          className="flex-1 bg-black/45 border border-white/15 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]"
        />
        <button
          onClick={() => send()}
          disabled={sending || !input.trim()}
          className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-r from-[#00f2fe] to-[#4facfe] flex items-center justify-center disabled:opacity-40"
        >
          <Icon path={ICONS.send} className="w-4 h-4 text-black" />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// BROWSE — Departments -> Projects -> Documents drill-down (Phase 1-3's
// original 3-column workspace, reused unchanged for the Departments/
// Projects/Documents sidebar entries).
// ============================================================
function OrgWorkspace({ orgId, departmentIds, canManage, initialDeptId, initialProjectId }) {
  const [departments, setDepartments] = useState([]);
  const [selectedDeptId, setSelectedDeptId] = useState(initialDeptId);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState("");

  const loadDepartments = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/departments?orgId=${orgId}`);
      setDepartments(data.departments);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { loadDepartments(); }, [loadDepartments]);

  const loadProjects = useCallback(async (deptId) => {
    try {
      const data = await api(`/api/orgs/projects?orgId=${orgId}&departmentId=${deptId}`);
      setProjects(data.projects);
    } catch (err) {
      setError(err.message);
      setProjects([]);
    }
  }, [orgId]);

  useEffect(() => {
    if (selectedDeptId) loadProjects(selectedDeptId);
  }, [selectedDeptId, loadProjects]);

  const loadDocuments = useCallback(async (deptId, projectId) => {
    try {
      const data = await api(`/api/orgs/documents?orgId=${orgId}&departmentId=${deptId}&projectId=${projectId}`);
      setDocuments(data.documents);
    } catch (err) {
      setError(err.message);
      setDocuments([]);
    }
  }, [orgId]);

  useEffect(() => {
    if (selectedDeptId && selectedProjectId) loadDocuments(selectedDeptId, selectedProjectId);
  }, [selectedDeptId, selectedProjectId, loadDocuments]);

  function handleSelectDept(id) {
    setSelectedDeptId(id);
    setSelectedProjectId(null);
    setDocuments([]);
  }

  const visibleDepartments = canManage ? departments : departments.filter((d) => departmentIds.includes(d.id));

  return (
    <div>
      {error && <p className="text-red-400 text-xs mb-4">{error}</p>}
      {/* Always render all 3 columns -- previously ProjectColumn/DocumentColumn
          were omitted entirely until something upstream was selected, which
          left a grid-cols-3 layout with only 1 column filled and a huge
          empty void next to it (a real user flagged exactly this). Showing
          a "select something" placeholder in the unfilled columns keeps the
          3-column structure intact and makes the next step obvious. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="inaya-fade-in-up">
          <DepartmentColumn
            orgId={orgId}
            departments={visibleDepartments}
            selectedDeptId={selectedDeptId}
            onSelect={handleSelectDept}
            canManage={canManage}
            onCreated={loadDepartments}
          />
        </div>
        <div className="inaya-fade-in-up" style={{ animationDelay: "0.06s" }}>
          {selectedDeptId ? (
            <ProjectColumn
              orgId={orgId}
              departmentId={selectedDeptId}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onSelect={setSelectedProjectId}
              canManage={canManage}
              onCreated={() => loadProjects(selectedDeptId)}
            />
          ) : (
            <Column title="Projects">
              <EmptyState compact icon="👈" description="Select a department to see its projects." />
            </Column>
          )}
        </div>
        <div className="inaya-fade-in-up" style={{ animationDelay: "0.12s" }}>
          {selectedDeptId && selectedProjectId ? (
            <DocumentColumn
              orgId={orgId}
              departmentId={selectedDeptId}
              projectId={selectedProjectId}
              documents={documents}
              canManage={canManage}
              onUploaded={() => loadDocuments(selectedDeptId, selectedProjectId)}
            />
          ) : (
            <Column title="Documents">
              <WorkflowVisualization />
              <p className="text-[#94a3b8] text-xs text-center mt-1">
                {selectedDeptId ? "Select a project to see its documents." : "Select a department, then a project, to see its documents."}
              </p>
            </Column>
          )}
        </div>
      </div>
    </div>
  );
}

function Column({ title, children, action }) {
  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function DepartmentColumn({ orgId, departments, selectedDeptId, onSelect, canManage, onCreated }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/orgs/departments", { method: "POST", body: JSON.stringify({ orgId, name }) });
      setName("");
      setCreating(false);
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Column title="Departments" action={canManage && <button onClick={() => setCreating((v) => !v)} className="text-[12px] font-bold text-[#00f2fe]">+ New</button>}>
      {creating && (
        <form onSubmit={handleCreate} className="mb-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finance" autoFocus className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-white" />
          <button className="text-[12px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 rounded-lg">Add</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[12px] mb-2">{error}</p>}
      {departments.length === 0 ? (
        <EmptyState compact icon="🏢" description="No departments yet." ctaLabel={canManage ? "+ Create one" : undefined} onCta={canManage ? () => setCreating(true) : undefined} />
      ) : (
        <div className="space-y-1">
          {departments.map((d) => (
            <button key={d.id} onClick={() => onSelect(d.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedDeptId === d.id ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-slate-300 hover:bg-white/5"}`}>
              {d.name}
            </button>
          ))}
        </div>
      )}
    </Column>
  );
}

function ProjectColumn({ orgId, departmentId, projects, selectedProjectId, onSelect, canManage, onCreated }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/orgs/projects", { method: "POST", body: JSON.stringify({ orgId, departmentId, name }) });
      setName("");
      setCreating(false);
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Column title="Projects" action={canManage && <button onClick={() => setCreating((v) => !v)} className="text-[12px] font-bold text-[#00f2fe]">+ New</button>}>
      {creating && (
        <form onSubmit={handleCreate} className="mb-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Audit" autoFocus className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-white" />
          <button className="text-[12px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 rounded-lg">Add</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[12px] mb-2">{error}</p>}
      {projects.length === 0 ? (
        <EmptyState compact icon="📁" description="No projects yet." ctaLabel={canManage ? "+ Create one" : undefined} onCta={canManage ? () => setCreating(true) : undefined} />
      ) : (
        <div className="space-y-1">
          {projects.map((p) => (
            <button key={p.id} onClick={() => onSelect(p.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedProjectId === p.id ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-slate-300 hover:bg-white/5"}`}>
              {p.name}
            </button>
          ))}
        </div>
      )}
    </Column>
  );
}

// Phase 2 — workflow status display + transition actions. Every action
// button just calls POST /api/orgs/documents/:id/transition; all the real
// enforcement (role, current state, org/department scoping) happens
// server-side in src/lib/document-workflow.js — these buttons are shown/
// hidden for UX clarity only, not as the actual access control.

// [action, label, whoCanSeeIt] — "member" means visible to anyone with
// department access, "manage" means owner/admin only (matches
// TRANSITIONS' requiresManage in document-workflow.js exactly).
const ACTIONS_BY_STATUS = {
  DRAFT: [["submit", "Submit for review", "member"]],
  PENDING: [["startReview", "Start review", "manage"]],
  UNDER_REVIEW: [["approve", "Approve", "manage"], ["reject", "Reject", "manage"]],
  REJECTED: [["revise", "Revise", "member"]],
  APPROVED: [["archive", "Archive", "manage"]],
  ARCHIVED: [["restore", "Restore", "manage"]],
};

const ACCESS_LEVEL_HINTS = {
  PRIVATE: "Only you and people you explicitly grant access to",
  DEPARTMENT: "Anyone in this department",
  PROJECT: "Anyone added to this project",
};

function DocumentColumn({ orgId, departmentId, projectId, documents, canManage, onUploaded }) {
  const [file, setFile] = useState(null);
  const [passkey, setPasskey] = useState("");
  const [accessLevel, setAccessLevel] = useState("DEPARTMENT");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function handleUpload(e) {
    e.preventDefault();
    if (!file || !passkey) return;
    setUploading(true);
    setError("");
    try {
      const { fileHash, sizeBytes, cidAlpha, cidBeta } = await encryptAndShardFile(file, passkey);

      await api("/api/orgs/documents", {
        method: "POST",
        body: JSON.stringify({ orgId, departmentId, projectId, filename: file.name, fileHash, sizeBytes, cidAlpha, cidBeta, accessLevel }),
      });

      setFile(null);
      setPasskey("");
      onUploaded();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Column title="Documents">
      <form onSubmit={handleUpload} className="mb-4 space-y-2">
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-[12px] text-slate-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[12px] file:font-bold file:bg-[#00f2fe]/10 file:text-[#00f2fe]" />
        <input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder="Encryption passkey" className="w-full bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-white" />
        <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-white">
          <option value="PRIVATE">Private</option>
          <option value="DEPARTMENT">Department</option>
          <option value="PROJECT">Project</option>
        </select>
        <p className="text-[11px] text-[#94a3b8]">{ACCESS_LEVEL_HINTS[accessLevel]}</p>
        <button disabled={uploading || !file || !passkey} className="w-full text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] py-2 rounded-lg disabled:opacity-40">
          {uploading ? "Encrypting & uploading…" : "Upload document"}
        </button>
      </form>
      {error && <p className="text-red-400 text-[12px] mb-2">{error}</p>}
      {documents.length === 0 ? (
        <EmptyState compact icon="🔐" description="No documents yet — use the upload form above." />
      ) : (
        <div className="space-y-2">
          {documents.map((d) => (
            <DocumentCard key={d.id} doc={d} orgId={orgId} canManage={canManage} onChanged={onUploaded} />
          ))}
        </div>
      )}
    </Column>
  );
}

function DocumentCard({ doc, orgId, canManage, onChanged }) {
  const [acting, setActing] = useState("");
  const [error, setError] = useState("");
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  const [downloadPasskey, setDownloadPasskey] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const availableActions = (ACTIONS_BY_STATUS[doc.status] || []).filter(([, , who]) => who === "member" || canManage);
  const canManageThisDoc = canManage || doc.yourAccessLevel === "MANAGE";

  async function loadActivity() {
    setLoadingActivity(true);
    try {
      const data = await api(`/api/orgs/documents/${doc.id}/activity?orgId=${orgId}`);
      setActivity(data.activity);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingActivity(false);
    }
  }

  async function handleAction(action) {
    setActing(action);
    setError("");
    try {
      await api(`/api/orgs/documents/${doc.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      onChanged();
      // The history panel, if open, would otherwise keep showing the
      // pre-transition snapshot — refetch so a new action's entry shows up
      // immediately instead of only after closing and reopening it.
      if (showActivity) loadActivity();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  function toggleActivity() {
    if (showActivity) {
      setShowActivity(false);
      return;
    }
    setShowActivity(true);
    loadActivity();
  }

  async function handleDownload() {
    if (!downloadPasskey) return;
    setDownloading(true);
    setError("");
    try {
      const info = await api(`/api/orgs/documents/${doc.id}/retrieve?orgId=${orgId}`);
      const [shardA, shardB] = await Promise.all([fetchShardFromIPFS(info.cidAlpha), fetchShardFromIPFS(info.cidBeta)]);
      const dataUrl = await decryptData(shardA + shardB, downloadPasskey);
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = info.filename;
      a.click();
      setShowDownload(false);
      setDownloadPasskey("");
    } catch (err) {
      setError(err.message || "Could not decrypt — check the passkey.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-white truncate">{doc.filename}</div>
          <div className="text-[12px] text-[#94a3b8] font-mono mt-0.5">{(doc.sizeBytes / 1024).toFixed(1)} KB · {doc.uploadedByEmail}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_STYLES[doc.status] || STATUS_STYLES.DRAFT}`}>
            {doc.status.replace("_", " ")}
          </span>
          <span className="text-[10px] font-mono text-[#94a3b8]">{doc.accessLevel}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {availableActions.map(([action, label]) =>
          action === "archive" ? (
            <ConfirmButton
              key={action}
              onConfirm={() => handleAction(action)}
              disabled={!!acting}
              className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-40"
            >
              {acting === action ? "…" : label}
            </ConfirmButton>
          ) : (
            <button
              key={action}
              onClick={() => handleAction(action)}
              disabled={!!acting}
              className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-40"
            >
              {acting === action ? "…" : label}
            </button>
          )
        )}
        <button onClick={() => setShowDownload((v) => !v)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">
          Download
        </button>
        {canManageThisDoc && (
          <>
            <button onClick={() => setShowPermissions((v) => !v)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">
              Permissions
            </button>
            <button onClick={() => setShowShare((v) => !v)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">
              Share
            </button>
          </>
        )}
        <button onClick={toggleActivity} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md text-[#94a3b8] hover:text-slate-300 ml-auto">
          {showActivity ? "Hide history" : "History"}
        </button>
      </div>

      {error && <p className="text-red-400 text-[12px] mt-1.5">{error}</p>}

      {showDownload && (
        <div className="mt-2 border-t border-white/5 pt-2 flex gap-2">
          <input
            type="password"
            value={downloadPasskey}
            onChange={(e) => setDownloadPasskey(e.target.value)}
            placeholder="Encryption passkey"
            className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-white"
          />
          <button onClick={handleDownload} disabled={downloading || !downloadPasskey} className="text-[11px] font-bold uppercase px-3 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            {downloading ? "…" : "Go"}
          </button>
        </div>
      )}

      {showPermissions && <PermissionsPanel documentId={doc.id} orgId={orgId} ownerEmail={doc.uploadedByEmail} />}
      {showShare && <SharePanel documentId={doc.id} orgId={orgId} />}

      {showActivity && (
        <div className="mt-2 border-t border-white/5 pt-2 space-y-1">
          {loadingActivity ? (
            <p className="text-[#8a96ab] text-[12px] italic">Loading…</p>
          ) : activity && activity.length > 0 ? (
            activity.map((e) => (
              <div key={e.eventId} className="text-[12px] font-mono text-[#94a3b8]">
                <span className="text-slate-300">{e.action}</span>
                {e.previousState && <span> · {e.previousState} → {e.newState}</span>}
                <span> · {e.actorId} · {new Date(e.timestamp).toLocaleString()}</span>
                {e.metadata?.note && <span className="italic"> — "{e.metadata.note}"</span>}
              </div>
            ))
          ) : (
            <p className="text-[#8a96ab] text-[12px] italic">No activity recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PERMISSIONS PANEL — "people with access" per the SOW's mockup
// ============================================================
function PermissionsPanel({ documentId, orgId, ownerEmail }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newLevel, setNewLevel] = useState("VIEW");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/documents/${documentId}/permissions?orgId=${orgId}`);
      setGrants(data.grants);
    } catch (err) {
      setError(err.message);
    }
  }, [documentId, orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/permissions`, { method: "POST", body: JSON.stringify({ orgId, email: newEmail, level: newLevel }) });
      setNewEmail("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleChange(email, level) {
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/permissions`, { method: "POST", body: JSON.stringify({ orgId, email, level }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRevoke(email) {
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/permissions`, { method: "DELETE", body: JSON.stringify({ orgId, email }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <p className="text-[11px] font-bold uppercase text-[#94a3b8] mb-1.5">People with access</p>
      <div className="flex items-center justify-between text-[12px] py-1">
        <span className="text-slate-300 truncate">{ownerEmail}</span>
        <span className="text-[#94a3b8] font-mono">Owner</span>
      </div>
      {grants === null ? (
        <p className="text-[#8a96ab] text-[12px] italic">Loading…</p>
      ) : (
        grants.map((g) => (
          <div key={g.email} className="flex items-center justify-between gap-2 text-[12px] py-1">
            <span className="text-slate-300 truncate">{g.email}</span>
            <div className="flex items-center gap-1 shrink-0">
              <select value={g.level} onChange={(e) => handleChange(g.email, e.target.value)} className="bg-black/45 border border-white/15 rounded px-1 py-0.5 text-[11px] text-white">
                <option value="VIEW">View</option>
                <option value="EDIT">Edit</option>
                <option value="MANAGE">Manage</option>
              </select>
              <ConfirmButton onConfirm={() => handleRevoke(g.email)} className="text-red-400 hover:text-red-300 text-[11px] font-bold uppercase px-1.5">Revoke</ConfirmButton>
            </div>
          </div>
        ))
      )}
      <form onSubmit={handleAdd} className="flex items-center gap-1.5 mt-2">
        <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" required placeholder="Add person by email" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[12px] text-white" />
        <select value={newLevel} onChange={(e) => setNewLevel(e.target.value)} className="bg-black/45 border border-white/15 rounded px-1 py-1 text-[11px] text-white">
          <option value="VIEW">View</option>
          <option value="EDIT">Edit</option>
          <option value="MANAGE">Manage</option>
        </select>
        <button disabled={submitting} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">+ Add</button>
      </form>
      {error && <p className="text-red-400 text-[12px] mt-1">{error}</p>}
    </div>
  );
}

// ============================================================
// SHARE PANEL — secure share link creation + active shares + revoke
// ============================================================
function SharePanel({ documentId, orgId }) {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [preset, setPreset] = useState("24h");
  const [maxUses, setMaxUses] = useState("");
  const [newShareUrl, setNewShareUrl] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/documents/${documentId}/shares?orgId=${orgId}`);
      setShares(data.shares);
    } catch (err) {
      setError(err.message);
    }
  }, [documentId, orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError("");
    setNewShareUrl("");
    try {
      const body = { orgId, expirationPreset: preset };
      if (maxUses) body.maxUses = Number(maxUses);
      const data = await api(`/api/orgs/documents/${documentId}/shares`, { method: "POST", body: JSON.stringify(body) });
      setNewShareUrl(data.shareUrl);
      setMaxUses("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(shareId) {
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/shares/${shareId}/revoke`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <p className="text-[11px] font-bold uppercase text-[#94a3b8] mb-1.5">Secure sharing</p>
      <form onSubmit={handleCreate} className="flex items-center gap-1.5">
        <select value={preset} onChange={(e) => setPreset(e.target.value)} className="bg-black/45 border border-white/15 rounded px-1.5 py-1 text-[11px] text-white">
          <option value="1h">Expires in 1 hour</option>
          <option value="24h">Expires in 24 hours</option>
          <option value="7d">Expires in 7 days</option>
          <option value="30d">Expires in 30 days</option>
        </select>
        <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} type="number" min="1" placeholder="Max uses (optional)" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[12px] text-white" />
        <button disabled={creating} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
          {creating ? "…" : "Create link"}
        </button>
      </form>

      {newShareUrl && (
        <div className="mt-2 bg-black/20 border border-white/10 rounded-lg p-2">
          <p className="text-[11px] text-[#94a3b8] mb-1">Share this link — it won't be shown again:</p>
          <p className="text-[12px] text-[#00f2fe] break-all font-mono">{newShareUrl}</p>
        </div>
      )}

      {error && <p className="text-red-400 text-[12px] mt-1">{error}</p>}

      <div className="mt-2 space-y-1">
        {shares === null ? (
          <p className="text-[#8a96ab] text-[12px] italic">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="text-[#8a96ab] text-[12px] italic">No share links yet.</p>
        ) : (
          shares.map((s) => (
            <div key={s.shareId} className="flex items-center justify-between gap-2 text-[12px] bg-black/20 rounded px-2 py-1">
              <span className="text-slate-300">
                {s.status} · {s.useCount}{s.maxUses !== null ? `/${s.maxUses}` : ""} uses · expires {new Date(s.expiresAt).toLocaleString()}
              </span>
              {s.status === "active" && (
                <ConfirmButton onConfirm={() => handleRevoke(s.shareId)} className="text-red-400 hover:text-red-300 text-[11px] font-bold uppercase shrink-0">Revoke</ConfirmButton>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// TEAM VIEW (Settings)
// ============================================================
// ============================================================
// BILLING — current plan, usage against its limits, and a plan switcher.
// ============================================================
function UsageBar({ label, used, max, unit = "" }) {
  const unlimited = max === null || max === undefined;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / max) * 100));
  const barColor = pct >= 90 ? "bg-red-400" : pct >= 70 ? "bg-amber-400" : "bg-[#00f2fe]";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[#94a3b8] text-[12px] font-bold uppercase tracking-wide">{label}</p>
        <p className="text-white text-xs font-mono">{unlimited ? `${used}${unit} · Unlimited` : `${used}${unit} / ${max}${unit}`}</p>
      </div>
      <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${unlimited ? "bg-[#00f2fe]/25" : barColor}`} style={{ width: unlimited ? "100%" : `${pct}%` }} />
      </div>
    </div>
  );
}

function BillingView({ orgId, canManage }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [switchingPlanId, setSwitchingPlanId] = useState(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/orgs/billing?orgId=${orgId}`);
      setData(d);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSwitch(planId) {
    setSwitchingPlanId(planId);
    setError("");
    try {
      const d = await api("/api/orgs/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ orgId, planId, interval: "month" }),
      });
      window.location.href = d.url;
    } catch (err) {
      setError(err.message);
      setSwitchingPlanId(null);
    }
  }

  async function handlePortal() {
    setPortalLoading(true);
    setError("");
    try {
      const d = await api("/api/orgs/billing/portal", { method: "POST", body: JSON.stringify({ orgId }) });
      window.location.href = d.url;
    } catch (err) {
      setError(err.message);
      setPortalLoading(false);
    }
  }

  if (!data) {
    return <p className="text-[#94a3b8] text-sm">{error || "Loading…"}</p>;
  }

  const { plan, usage, subscription, availablePlans } = data;

  return (
    <div className="space-y-6">
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <p className="text-[#94a3b8] text-[12px] font-bold uppercase tracking-wide">Current plan</p>
            <p className="text-white text-xl font-extrabold">{plan.name}</p>
            {subscription && (
              <p className="text-[#94a3b8] text-[13px] font-mono mt-0.5">
                {subscription.status}
                {subscription.currentPeriodEnd ? ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ""}
              </p>
            )}
          </div>
          {subscription && (
            <button
              onClick={handlePortal}
              disabled={portalLoading}
              className="text-[12px] font-bold uppercase bg-white/5 border border-white/10 px-3 py-2 rounded-lg text-slate-300 hover:bg-white/10 disabled:opacity-40"
            >
              {portalLoading ? "Opening…" : "Manage billing"}
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UsageBar label="Users" used={usage.users.used} max={usage.users.max} />
          <UsageBar label="Storage" used={usage.storageGB.used} max={usage.storageGB.max} unit=" GB" />
        </div>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {canManage && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8]">Change plan</h3>
            <a href="/business/pricing" target="_blank" rel="noopener noreferrer" className="text-[12px] font-bold text-[#00f2fe]">
              Full pricing page ↗
            </a>
          </div>
          <div className="bg-amber-400/10 border border-amber-400/40 rounded-xl px-4 py-2.5 flex items-center gap-2 mb-4">
            <span className="text-amber-400 text-sm">⚠️</span>
            <p className="text-[12px] text-amber-300 font-bold font-mono">
              TEST MODE — use card 4242 4242 4242 4242, any future expiry, any CVC/ZIP.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {availablePlans.map((p) => (
              <PricingCard
                key={p.id}
                plan={p}
                current={plan.id === p.id}
                loading={switchingPlanId === p.id}
                onSelect={() => (p.contactSalesOnly ? (window.location.href = "mailto:sales@inaya.ai") : handleSwitch(p.id))}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamView({ orgId, email }) {
  const [members, setMembers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteDeptIds, setInviteDeptIds] = useState([]);
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [savingNotifyPref, setSavingNotifyPref] = useState(false);

  const load = useCallback(async () => {
    try {
      const [membersData, deptData] = await Promise.all([
        api(`/api/orgs/members?orgId=${orgId}`),
        api(`/api/orgs/departments?orgId=${orgId}`),
      ]);
      setMembers(membersData.members);
      setDepartments(deptData.departments);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleInvite(e) {
    e.preventDefault();
    setInviting(true);
    setError("");
    setInviteResult(null);
    try {
      const data = await api("/api/orgs/invite", {
        method: "POST",
        body: JSON.stringify({ orgId, email: inviteEmail, role: inviteRole, departmentIds: inviteDeptIds }),
      });
      setInviteResult(data);
      setInviteEmail("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setInviting(false);
    }
  }

  function toggleDept(id) {
    setInviteDeptIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleToggleNotify(next) {
    setSavingNotifyPref(true);
    try {
      await api("/api/orgs/members/notify-preference", {
        method: "POST",
        body: JSON.stringify({ orgId, notifyOnApprovals: next }),
      });
      setMembers((prev) => prev.map((m) => (m.email === email ? { ...m, notifyOnApprovals: next } : m)));
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingNotifyPref(false);
    }
  }

  const ownMembership = members.find((m) => m.email === email);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8] mb-4">Invite someone</h3>
        <form onSubmit={handleInvite} className="space-y-3">
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required type="email" placeholder="colleague@company.com" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white" />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <div>
            <p className="text-[12px] text-[#94a3b8] uppercase mb-1.5">Departments</p>
            <div className="flex flex-wrap gap-1.5">
              {departments.map((d) => (
                <button type="button" key={d.id} onClick={() => toggleDept(d.id)} className={`text-[12px] px-2.5 py-1 rounded-full border ${inviteDeptIds.includes(d.id) ? "bg-[#00f2fe]/15 border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-slate-400"}`}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
          <button disabled={inviting} className="w-full py-2 rounded-lg text-xs font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </form>
        {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
        {inviteResult && (
          <div className="mt-3 bg-black/20 border border-white/10 rounded-lg p-3">
            <p className="text-slate-400 text-xs mb-1">{inviteResult.emailSent ? "Invite emailed." : "Share this invite link:"}</p>
            <a href={inviteResult.inviteUrl} className="text-[#00f2fe] underline text-[12px] break-all">{inviteResult.inviteUrl}</a>
          </div>
        )}
      </div>

      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#94a3b8] mb-4">Members</h3>

        {ownMembership && (ownMembership.role === "owner" || ownMembership.role === "admin") && (
          <div className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 mb-3">
            <div className="min-w-0">
              <p className="text-xs text-white">Email me when something needs my approval</p>
              <p className="text-[12px] text-[#94a3b8] mt-0.5">Sent the moment a document is submitted — you can turn this off if it's too noisy.</p>
            </div>
            <button
              onClick={() => handleToggleNotify(!ownMembership.notifyOnApprovals)}
              disabled={savingNotifyPref}
              className={`shrink-0 relative w-10 h-6 rounded-full transition-colors disabled:opacity-40 ${ownMembership.notifyOnApprovals ? "bg-[#00f2fe]/60" : "bg-white/10"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${ownMembership.notifyOnApprovals ? "translate-x-[18px]" : "translate-x-0.5"}`} />
            </button>
          </div>
        )}

        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.email} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg p-2.5">
              <div className="min-w-0">
                <div className="text-xs text-white truncate">{m.email}</div>
                <div className="text-[12px] text-[#94a3b8] font-mono">{ROLE_LABELS[m.role]} · {m.status === "active" ? "Active" : "Invited"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
