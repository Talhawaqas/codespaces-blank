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
import { Icon, ICONS } from "../../components/business/ui/icons";
import WorkflowVisualization from "../../components/business/WorkflowVisualization";
import AIWidget from "../../components/business/AIWidget";
import VoiceAssistantControl from "../../components/business/VoiceAssistantControl";
import TasksView from "../../components/business/TasksView";
import CRMView from "../../components/business/CRMView";
import ProcurementView from "../../components/business/ProcurementView";
import InventoryView from "../../components/business/InventoryView";
import FinanceView from "../../components/business/FinanceView";
import HRView from "../../components/business/HRView";
import HealthView from "../../components/business/HealthView";
import LegalView from "../../components/business/LegalView";
import RegulatedView from "../../components/business/RegulatedView";
import FinancialView from "../../components/business/FinancialView";
import GovernmentView from "../../components/business/GovernmentView";
import GlobeBackground from "../../components/GlobeBackground";
import SecurityResilienceView from "../../components/business/SecurityResilienceView";
import IntegrationsView from "../../components/business/IntegrationsView";
import ExecutiveDashboardView from "../../components/business/ExecutiveDashboardView";
import DataRoomsView from "../../components/business/DataRoomsView";
import EnterpriseHardeningView from "../../components/business/EnterpriseHardeningView";
import InsightsView from "../../components/business/InsightsView";
import AIActionRequestsView from "../../components/business/AIActionRequestsView";
import AuditTrailView from "../../components/business/AuditTrailView";
import ComplianceEvidenceView from "../../components/business/ComplianceEvidenceView";
import BriefView from "../../components/business/BriefView";
import ActivityCenterView from "../../components/ActivityCenterView";
import OsHomeView from "../../components/business/OsHomeView";
import MfaVerifyScreen from "../../components/business/MfaVerifyScreen";
import MfaSettings from "../../components/business/MfaSettings";
import ThemeSwitcher from "../../components/ThemeSwitcher";
import { encryptAndShardFile } from "../../lib/clientCrypto";
import ConfirmButton from "../../components/business/ConfirmButton";
import { OrgProvider } from "../../contexts/OrgContext";
import NotificationsBell from "../../components/NotificationsBell";
import CommandPalette from "../../components/CommandPalette";
import GuidedTaskPanel from "../../components/business/GuidedTaskPanel";
import TrustRelationshipsView from "../../components/business/TrustRelationshipsView";
import ApiKeysView from "../../components/business/ApiKeysView";
import S3CompatView from "../../components/business/S3CompatView";
import BusinessEventsView from "../../components/business/BusinessEventsView";
import WhatIfStudioView from "../../components/business/WhatIfStudioView";
import CloudBackupSchedulerView from "../../components/business/CloudBackupSchedulerView";
import ResilienceView from "../../components/business/ResilienceView";
import SignView from "../../components/business/SignView";
import StorageManagerView from "../../components/business/StorageManagerView";
import EscrowView from "../../components/business/EscrowView";
import AttestationsView from "../../components/business/AttestationsView";

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
  const [mfaPendingToken, setMfaPendingToken] = useState(null);

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
    const mfaPending = params.get("mfaPending");
    if (mfaPending) setMfaPendingToken(mfaPending);
    if (params.get("orgLoggedIn") || params.get("orgLoginError") || mfaPending) {
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
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      </CenteredShell>
    );
  }

  if (mfaPendingToken) {
    return (
      <CenteredShell>
        <MfaVerifyScreen
          mfaPendingToken={mfaPendingToken}
          onVerified={() => { setMfaPendingToken(null); refreshSession(); }}
          onCancel={() => setMfaPendingToken(null)}
        />
      </CenteredShell>
    );
  }

  if (!session?.authenticated) {
    return (
      <CenteredShell>
        <AuthScreen notice={notice} onAuthed={refreshSession} onMfaRequired={setMfaPendingToken} />
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
        <OrgProvider
          key={currentMembership.orgId}
          email={session.email}
          membership={currentMembership}
          orgs={session.orgs}
          selectedOrgId={currentMembership.orgId}
          onSwitchOrg={setSelectedOrgId}
          onLogout={handleLogout}
          refreshSession={refreshSession}
        >
          <Workspace
            email={session.email}
            membership={currentMembership}
            orgs={session.orgs}
            selectedOrgId={currentMembership.orgId}
            onSwitchOrg={setSelectedOrgId}
            onLogout={handleLogout}
          />
        </OrgProvider>
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
  const [continuingWithoutPlan, setContinuingWithoutPlan] = useState(false);

  async function handleContinueWithoutPlan() {
    setContinuingWithoutPlan(true);
    setError("");
    try {
      await api("/api/orgs/billing/continue-without-plan", { method: "POST", body: JSON.stringify({ orgId: membership.orgId }) });
      window.location.reload(); // simplest way for BusinessPage to re-derive membership and drop the gate
    } catch (err) {
      setError(err.message);
      setContinuingWithoutPlan(false);
    }
  }

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
            <p className="text-[var(--inaya-text-muted)] text-xs font-mono">{email} · {membership.orgName}</p>
            <h1 className="text-2xl font-extrabold text-[var(--inaya-text-primary)] mt-1">Activate your workspace</h1>
            <p className="text-[var(--inaya-text-muted)] text-sm mt-1 max-w-xl">
              You signed up but haven't chosen a plan yet. Pick one to get started — every plan includes a 14-day free trial, and since this runs on Inaya's testnet, nothing is actually charged during the trial. Not ready to commit? You can also continue on limited free features below.
            </p>
          </div>
          <button onClick={onLogout} className="text-[12px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-3 py-2 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] shrink-0">
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
        {!plans && !error && <p className="text-[var(--inaya-text-muted)] text-sm">Loading plans…</p>}

        {plans && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {plans.map((plan) => (
              <PricingCard key={plan.id} plan={plan} loading={switchingPlanId === plan.id} onSelect={() => handleSelect(plan)} />
            ))}
          </div>
        )}

        <div className="mt-8 flex flex-col items-center gap-2 text-center">
          <p className="text-[var(--inaya-text-muted)] text-xs">Not ready to pick a plan?</p>
          <button
            onClick={handleContinueWithoutPlan}
            disabled={continuingWithoutPlan}
            className="text-[12px] font-bold uppercase text-[var(--inaya-text-primary)] bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-4 py-2.5 rounded-lg hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40"
          >
            {continuingWithoutPlan ? "Setting up…" : "Continue without a plan (free, Starter limits)"}
          </button>
          <p className="text-[var(--inaya-text-muted)] text-[11px] max-w-sm">
            2 users, 250 GB storage, 5 GB max file size — the same limits as Starter, at no cost. You can upgrade to a paid plan anytime from Billing.
          </p>
        </div>
      </div>
    </div>
  );
}

function CenteredShell({ children }) {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10 relative overflow-hidden z-0">
      <GlobeBackground variant="ambient" />
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
function AuthScreen({ notice, onAuthed, onMfaRequired }) {
  const [mode, setMode] = useState("signin"); // 'signin' | 'create'
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  // Healthcare & Legal Expansion SOW — the company-type picker at signup.
  // Determines which of the Health OS / Legal OS nav items this org will
  // ever see (Sidebar's NAV_ITEMS filter, business/page.js) — a UI gate,
  // not the actual security boundary (getAccessibleScope() is), but this
  // is what stops a generic company's workspace from showing modules that
  // don't apply to their business at all.
  const [vertical, setVertical] = useState("general");
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
        const data = await api("/api/orgs/login/google", { method: "POST", body: JSON.stringify({ idToken: response.credential }) });
        if (data.mfaRequired) {
          onMfaRequired(data.mfaPendingToken);
          return;
        }
        onAuthed();
      } catch (err) {
        setGoogleError(err.message);
      }
    },
    [onAuthed, onMfaRequired]
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
        const data = await api("/api/orgs/create", { method: "POST", body: JSON.stringify({ orgName, ownerEmail: email, vertical }) });
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
        <a href="/" className="inline-block text-[var(--inaya-text-muted)] hover:text-slate-300 text-xs font-mono mb-8">← Inaya Network</a>
        <h1 className="text-2xl font-extrabold text-[var(--inaya-text-primary)] mb-1">Business Records</h1>
        <p className="text-[var(--inaya-text-muted)] text-sm mb-8">Encrypted document management for your company, built on Inaya's storage infrastructure.</p>

        {notice && <div className="bg-amber-400/10 border border-amber-400/20 text-amber-300 text-xs rounded-lg p-3 mb-4">{notice}</div>}

        <div className="flex bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-xl p-1 mb-6">
          <button onClick={() => setMode("signin")} className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg ${mode === "signin" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Sign in</button>
          <button onClick={() => setMode("create")} className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg ${mode === "create" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Create a company</button>
        </div>

        <div ref={googleButtonRef} className="flex justify-center mb-2" />
        {googleError && <p className="text-red-400 text-xs text-center mb-3">{googleError}</p>}
        {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && (
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-[var(--inaya-overlay-10)]" />
            <span className="text-[12px] text-[#8a96ab] uppercase font-bold">or</span>
            <div className="flex-1 h-px bg-[var(--inaya-overlay-10)]" />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "create" && (
            <>
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required placeholder="Company name" className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-2.5 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
              <select value={vertical} onChange={(e) => setVertical(e.target.value)} className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-2.5 text-sm text-[var(--inaya-text-primary)]">
                <option value="general">General business</option>
                <option value="healthcare">Healthcare (Health OS)</option>
                <option value="legal">Legal / Law firm (Legal OS)</option>
                <option value="regulated">Regulated enterprise (Regulated Enterprise OS)</option>
                <option value="financial">Hedge fund / asset manager (Financial Services OS)</option>
                <option value="private_capital">Private equity / venture capital (Private Capital OS)</option>
                <option value="government">Government / public sector (Government OS)</option>
              </select>
            </>
          )}
          <input value={email} onChange={(e) => setEmail(e.target.value)} required type="email" placeholder="you@company.com" className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-2.5 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={submitting} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {submitting ? "Working…" : mode === "create" ? "Create company" : "Send sign-in link"}
          </button>
        </form>

        {error && <p className="text-red-400 text-xs mt-4">{error}</p>}
        {message && <p className="text-emerald-400 text-xs mt-4">{message}</p>}
        {fallbackUrl && (
          <div className="mt-3 bg-black/20 border border-[var(--inaya-overlay-10)] rounded-xl p-4">
            <p className="text-slate-400 text-xs mb-2">Email delivery isn't fully set up yet — use this link directly:</p>
            <a href={fallbackUrl} className="text-[#00f2fe] underline text-xs break-all">{fallbackUrl}</a>
          </div>
        )}

        <a
          href="/docs/business-workspace-guide.md"
          download
          className="mt-8 flex items-center justify-center gap-2 text-xs text-[var(--inaya-text-muted)] hover:text-[#00f2fe] border border-[var(--inaya-overlay-10)] hover:border-[#00f2fe]/30 rounded-xl py-2.5"
        >
          <span aria-hidden>↓</span> Download the step-by-step setup guide
        </a>
        <a
          href="/business/download"
          className="mt-2 flex items-center justify-center gap-2 text-xs text-[var(--inaya-text-muted)] hover:text-[#00f2fe] border border-[var(--inaya-overlay-10)] hover:border-[#00f2fe]/30 rounded-xl py-2.5"
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
                <p className="text-[var(--inaya-text-primary)] text-sm font-bold leading-tight">{f.title}</p>
                <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">{f.desc}</p>
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
  const [vertical, setVertical] = useState("general");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/create", { method: "POST", body: JSON.stringify({ orgName, vertical }) });
      onCreated();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-16">
      <div className="flex items-center justify-between mb-8">
        <p className="text-[var(--inaya-text-muted)] text-xs font-mono truncate">{email}</p>
        <button onClick={onLogout} className="text-[12px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-slate-300 shrink-0 ml-2">
          Sign out
        </button>
      </div>
      <h1 className="text-2xl font-extrabold text-[var(--inaya-text-primary)] text-center mb-1">Name your company</h1>
      <p className="text-[var(--inaya-text-muted)] text-sm text-center mb-8">You're signed in but not part of any company yet — create one to get started.</p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          required
          placeholder="Company name"
          className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-2.5 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]"
        />
        <select value={vertical} onChange={(e) => setVertical(e.target.value)} className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-2.5 text-sm text-[var(--inaya-text-primary)]">
          <option value="general">General business</option>
          <option value="healthcare">Healthcare (Health OS)</option>
          <option value="legal">Legal / Law firm (Legal OS)</option>
          <option value="regulated">Regulated enterprise (Regulated Enterprise OS)</option>
          <option value="financial">Hedge fund / asset manager (Financial Services OS)</option>
          <option value="private_capital">Private equity / venture capital (Private Capital OS)</option>
          <option value="government">Government / public sector (Government OS)</option>
        </select>
        <button disabled={submitting} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
          {submitting ? "Creating…" : "Create company"}
        </button>
      </form>

      {error && <p className="text-red-400 text-xs mt-4">{error}</p>}
    </div>
  );
}

// ============================================================
// SIDEBAR + WORKSPACE SHELL
// ============================================================
// Icon/ICONS now imported from components/business/ui/icons.js -- see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.1 for why this used to be a locally
// defined, unexported duplicate reinvented in 2 other files.
// UI Enhancement Specs v2, §3 -- each item's `group` drives the sidebar's
// micro-heading chunking. Order here is also render order, so items in
// the same group stay contiguous; GROUP_LABELS below defines display order
// and text independently of these internal keys.
const NAV_ITEMS = [
  { key: "osHome", label: "OS Home", icon: "dashboard", group: "core" },
  { key: "insights", label: "Insights", icon: "insights", group: "core" },
  { key: "brief", label: "Brief", icon: "insights", group: "core" },
  { key: "whatChanged", label: "What Changed?", icon: "insights", group: "core" },
  { key: "departments", label: "Departments", icon: "departments", group: "operations" },
  { key: "projects", label: "Projects", icon: "projects", group: "operations" },
  { key: "documents", label: "Documents", icon: "documents", group: "operations" },
  { key: "tasks", label: "Tasks", icon: "tasks", group: "operations" },
  { key: "crm", label: "CRM", icon: "crm", group: "operations" },
  { key: "procurement", label: "Procurement", icon: "procurement", group: "operations" },
  { key: "inventory", label: "Inventory", icon: "inventory", group: "operations" },
  { key: "finance", label: "Finance", icon: "finance", group: "operations" },
  { key: "hr", label: "HR", icon: "hr", group: "operations" },
  { key: "sign", label: "Inaya Sign", icon: "documents", group: "operations" },
  { key: "escrow", label: "Milestone Escrow", icon: "finance", group: "operations" },
  { key: "storageManager", label: "DePIN Storage", icon: "resilience", group: "operations" },
  { key: "attestations", label: "Attestations", icon: "financial", group: "operations" },
  { key: "health", label: "Health OS", icon: "health", verticalOnly: "healthcare", group: "industry" },
  { key: "legal", label: "Legal OS", icon: "legal", verticalOnly: "legal", group: "industry" },
  { key: "regulated", label: "Regulated OS", icon: "regulated", verticalOnly: "regulated", group: "industry" },
  { key: "financial", label: "Financial OS", icon: "financial", verticalOnly: ["financial", "private_capital"], group: "industry" },
  { key: "government", label: "Government OS", icon: "government", verticalOnly: "government", group: "industry" },
  { key: "security", label: "Account Security", icon: "activity", group: "trust" },
  { key: "resilience", label: "Security & Resilience Controls", icon: "resilience", manageOnly: true, group: "trust" },
  { key: "resilienceTesting", label: "Resilience Testing", icon: "resilience", manageOnly: true, group: "trust" },
  { key: "approvals", label: "Approvals", icon: "approvals", manageOnly: true, group: "trust" },
  { key: "aiActions", label: "AI Action Requests", icon: "aiAssistant", group: "trust" },
  { key: "evidence", label: "Evidence", icon: "lock", group: "trust" },
  { key: "whatIf", label: "What-If Studio", icon: "insights", group: "trust" },
  { key: "auditTrail", label: "Audit Trail", icon: "activity", manageOnly: true, group: "trust" },
  { key: "complianceEvidence", label: "Compliance Evidence", icon: "lock", manageOnly: true, group: "trust" },
  { key: "trustRelationships", label: "Cross-Org Trust", icon: "activity", manageOnly: true, group: "trust" },
  { key: "activity", label: "Activity", icon: "activity", group: "trust" },
  { key: "integrations", label: "Integrations", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "apiKeys", label: "API Keys", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "s3Compat", label: "S3-Compatible Storage", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "executive", label: "Executive", icon: "executive", manageOnly: true, group: "enterprise" },
  { key: "dataRooms", label: "Data Rooms", icon: "dataRooms", manageOnly: true, group: "enterprise" },
  { key: "cloudBackup", label: "Cloud Backup", icon: "health", manageOnly: true, group: "enterprise" },
  { key: "enterpriseHardening", label: "Export & Migration", icon: "enterpriseHardening", manageOnly: true, group: "enterprise" },
  { key: "ai", label: "AI Assistant", icon: "aiAssistant", group: "settings" },
  { key: "billing", label: "Billing", icon: "billing", manageOnly: true, group: "settings" },
  { key: "settings", label: "Settings", icon: "settings", manageOnly: true, group: "settings" },
];

const GROUP_LABELS = {
  core: "Core",
  operations: "Operations",
  industry: "Industry",
  trust: "Trust & Security",
  enterprise: "Enterprise",
  settings: "Settings",
};

// Business Workspace UX/UI Makeover SOW -- see VIEW_TITLES.browse's own
// comment for why this exists.
const BROWSE_SECTION_LABELS = { departments: "Departments", projects: "Projects", documents: "Documents" };

// Healthcare & Legal Expansion SOW — lets an existing org (created before
// this feature, or simply changing business type) switch which vertical
// nav items (Health OS / Legal OS) it sees, without needing to recreate
// the company. Owner/admin only (the settings view itself is already
// canManage-gated by its caller).
function OrgVerticalSettings({ orgId, vertical, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleChange(newVertical) {
    setSaving(true);
    setError("");
    try {
      await api("/api/orgs/settings", { method: "PATCH", body: JSON.stringify({ orgId, vertical: newVertical }) });
      onChanged(newVertical);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
      <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm mb-1">Company type</h3>
      <p className="text-[var(--inaya-text-muted)] text-xs mb-3">Controls which specialized modules (Health OS, Legal OS, Regulated Enterprise OS, Financial Services OS, Private Capital OS) show up in the sidebar for everyone in this company.</p>
      <select
        value={vertical}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="w-full max-w-xs bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] disabled:opacity-40"
      >
        <option value="general">General business</option>
        <option value="healthcare">Healthcare (Health OS)</option>
        <option value="legal">Legal / Law firm (Legal OS)</option>
        <option value="regulated">Regulated enterprise (Regulated Enterprise OS)</option>
        <option value="financial">Hedge fund / asset manager (Financial Services OS)</option>
        <option value="private_capital">Private equity / venture capital (Private Capital OS)</option>
        <option value="government">Government / public sector (Government OS)</option>
      </select>
      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  );
}

// Inaya AI Voice Assistant SOW -- the per-org opt-in half of the feature
// flag (isVoiceEnabledForOrg requires both this AND the global
// VOICE_AI_ENABLED env var). Defaults off; an owner/admin turns it on
// explicitly for their own company. Mirrors OrgVerticalSettings' pattern
// exactly (same PATCH /api/orgs/settings endpoint, same save/error
// handling shape).
function VoiceAiSettings({ orgId, aiPolicy, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const voiceEnabled = !!aiPolicy?.voiceEnabled;

  async function handleToggle() {
    setSaving(true);
    setError("");
    const nextPolicy = { ...aiPolicy, voiceEnabled: !voiceEnabled };
    try {
      await api("/api/orgs/settings", { method: "PATCH", body: JSON.stringify({ orgId, aiPolicy: nextPolicy }) });
      onChanged(nextPolicy);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm mb-1">Voice AI Assistant</h3>
          <p className="text-[var(--inaya-text-muted)] text-xs">Lets everyone in this company talk to Inaya by voice instead of typing, using the same business context, tools, and approval rules as the text assistant.</p>
        </div>
        <button
          onClick={handleToggle}
          disabled={saving}
          role="switch"
          aria-checked={voiceEnabled}
          className={`shrink-0 w-12 h-7 rounded-full relative transition-colors disabled:opacity-40 ${voiceEnabled ? "bg-[#00f2fe]" : "bg-white/10"}`}
        >
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-black transition-transform ${voiceEnabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  );
}

function Sidebar({ orgName, role, activeView, onNavigate, canManage, vertical, mobileOpen, onCloseMobile }) {
  return (
    <>
      {mobileOpen && <div onClick={onCloseMobile} className="fixed inset-0 bg-black/60 z-40 md:hidden" />}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 w-64 shrink-0 bg-[var(--inaya-surface)] border-r border-[var(--inaya-border)] flex flex-col transition-transform duration-200 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="px-5 py-6 border-b border-[var(--inaya-overlay-5)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
              <span className="text-black font-extrabold text-sm">I</span>
            </div>
            <div className="min-w-0">
              <p className="text-[var(--inaya-text-primary)] font-extrabold text-sm leading-tight truncate">Inaya Network</p>
              <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono uppercase tracking-wide">Business Workspace</p>
            </div>
          </div>
          <div className="mt-4 bg-black/30 border border-[var(--inaya-overlay-5)] rounded-lg px-3 py-2">
            <p className="text-[var(--inaya-text-primary)] text-xs font-bold truncate">{orgName}</p>
            <p className="text-[#00f2fe] text-[12px] font-mono uppercase tracking-wide mt-0.5">{ROLE_LABELS[role] || role}</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {(() => {
            const visible = NAV_ITEMS.filter((item) => (!item.manageOnly || canManage) && (!item.verticalOnly || (Array.isArray(item.verticalOnly) ? item.verticalOnly.includes(vertical) : item.verticalOnly === vertical)));
            let lastGroup = null;
            return visible.map((item) => {
              const showHeading = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.key}>
                  {showHeading && (
                    <p className={`px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] opacity-40 ${item === visible[0] ? "mb-1.5" : "mt-4 mb-1.5"}`}>
                      {GROUP_LABELS[item.group] || item.group}
                    </p>
                  )}
                  <button
                    onClick={() => onNavigate(item.key)}
                    className={`w-full flex items-center gap-3 pl-2.5 pr-3 py-2.5 rounded-lg text-sm font-medium border-l-2 transition-colors ${
                      activeView === item.key
                        ? "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe] shadow-[-2px_0_8px_rgba(0,242,254,0.35)]"
                        : "text-[var(--inaya-text-muted)] border-transparent hover:bg-[var(--inaya-overlay-5)] hover:text-slate-200"
                    }`}
                  >
                    <Icon path={ICONS[item.icon]} />
                    {item.label}
                  </button>
                </div>
              );
            });
          })()}
        </nav>

        <div className="px-3 pb-5">
          <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-emerald-400/5 border border-emerald-400/15">
            <Icon path={ICONS.lock} className="w-4 h-4 text-emerald-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-emerald-300 text-[12px] font-bold uppercase tracking-wide">End-to-end encrypted</p>
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">AES-256 · client-side</p>
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

  // Enterprise OS SOW, Phase 9 — reads a ?view= query param on first mount
  // so a pop-out window (open_module_window, a real separate native window
  // with no shared React state) can land directly on the right view
  // instead of always opening to OS Home. Safe to read window.location
  // here: Workspace only ever mounts client-side after the async session
  // fetch resolves (BusinessPage shows a loading/auth screen until then),
  // so there's no SSR render of this component to mismatch against.
  const [activeView, setActiveView] = useState(() => {
    if (typeof window === "undefined") return "osHome";
    return new URLSearchParams(window.location.search).get("view") || "osHome";
  });
  const [browseTarget, setBrowseTarget] = useState(null); // { deptId, projectId } — set when navigating in from Dashboard
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // AI-Powered Business Workspace SOW — one guided task at a time, lifted
  // here so both the compact AIWidget dock and the full-page AI Assistant
  // tab show the same in-progress state rather than each tracking their
  // own. Fetched once on mount so reloading mid-task resumes the panel
  // instead of losing it.
  const [guidedTask, setGuidedTask] = useState(null);
  useEffect(() => {
    api(`/api/orgs/guided-tasks?orgId=${orgId}`)
      .then((d) => setGuidedTask(d.tasks?.[0] || null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // The single piece of instrumentation every guided workflow's nav-based
  // steps rely on: fires whenever the visible screen changes, so
  // GuidedTaskPanel can auto-advance a "click X in the sidebar" step
  // without any per-view wiring.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("inaya:guided-nav", { detail: { view: activeView } }));
  }, [activeView]);

  // Healthcare & Legal Expansion SOW — Health OS / Legal OS nav items are
  // gated on the org's configured vertical, not shown unconditionally.
  // Defaults to "general" (industry-config.js's own default) until the
  // real value loads, so there's a one-frame flash of "no health/legal
  // nav" rather than a flash of nav items that then disappear.
  const [orgVertical, setOrgVertical] = useState("general");
  // Inaya AI Voice Assistant SOW -- the org's per-org opt-in, same fetch
  // as orgVertical above (both live on the same profile document).
  const [orgAiPolicy, setOrgAiPolicy] = useState({ enabled: true, voiceEnabled: false });
  useEffect(() => {
    api(`/api/orgs/settings?orgId=${orgId}`).then((d) => {
      setOrgVertical(d.profile?.vertical || "general");
      setOrgAiPolicy(d.profile?.aiPolicy || { enabled: true, voiceEnabled: false });
    }).catch(() => {});
  }, [orgId]);

  // Business Workspace UX/UI Makeover SOW -- which of Departments/
  // Projects/Documents was actually clicked, so the header can show the
  // real section name instead of always "Company Records" (see
  // BUSINESS_WORKSPACE_UX_AUDIT.md #3.2). All three still render the same
  // OrgWorkspace drill-down component underneath -- this only affects the
  // header title, not the routing.
  const [browseSection, setBrowseSection] = useState("documents");

  function navigate(view, target) {
    if (view === "departments" || view === "projects" || view === "documents") {
      setBrowseSection(view);
      setActiveView("browse");
    } else {
      setActiveView(view);
    }
    setBrowseTarget(target || null);
    setMobileNavOpen(false);
  }

  // Business Workspace UX/UI Makeover SOW -- each entry gains a short
  // description (SOW §9's page-standardization: title + description),
  // shown as the header's subtitle in place of the signed-in email (moved
  // to the header's right-side controls area). "dashboard" removed: the
  // former separate "Dashboard" screen was a redundant second home screen
  // (see the audit's #3.2) and has been consolidated into "OS Home" below.
  const VIEW_TITLES = {
    osHome: { title: "OS Home", description: `Welcome back — ${membership.orgName}. One place for what's happening across your organization.` },
    insights: { title: "Business Insights", description: "KPIs, trends, and alerts for this company." },
    brief: { title: "Business Brief", description: "A periodic recap of what happened and what needs attention." },
    whatChanged: { title: "What Changed?", description: "A running log of recent activity across the company." },
    security: { title: "Account Security", description: "Your own sign-in and multi-factor authentication settings." },
    browse: { title: BROWSE_SECTION_LABELS[browseSection], description: "Company → Department → Project → Document." },
    tasks: { title: "Tasks", description: "Track and assign work across departments and projects." },
    crm: { title: "CRM", description: "Customers, leads, deals, and the sales pipeline." },
    procurement: { title: "Procurement", description: "Purchase requests, purchase orders, and suppliers." },
    inventory: { title: "Inventory", description: "Products, stock levels, warehouses, and transfers." },
    finance: { title: "Finance", description: "Invoices, expenses, payments, and accounting." },
    hr: { title: "HR", description: "Employees, leave requests, and department administration." },
    sign: { title: "Inaya Sign", description: "Request and track signatures on company documents." },
    escrow: { title: "Milestone Escrow", description: "Milestone-based payment holds tied to purchase orders." },
    storageManager: { title: "DePIN Storage", description: "Decentralized storage capacity and policy for this company." },
    attestations: { title: "Attestations", description: "Cryptographic attestations for financial statements." },
    health: { title: "Health OS", description: "Clinical records and care workflows." },
    legal: { title: "Legal OS", description: "Matters, clients, and legal document workflows." },
    regulated: { title: "Regulated OS", description: "Compliance controls for regulated enterprises." },
    financial: { title: "Financial OS", description: "Fund, investor, and portfolio management." },
    government: { title: "Government OS", description: "Citizen records and case management." },
    resilience: { title: "Security & Resilience Controls", description: "Vendors, ICT assets, privileged access, and resilience policy." },
    resilienceTesting: { title: "Resilience Testing", description: "Disaster-recovery test results, RTO/RPO compliance, and test history." },
    integrations: { title: "Integrations", description: "Connect external identity, productivity, and financial systems." },
    apiKeys: { title: "API Keys", description: "Programmatic access to this company's data." },
    s3Compat: { title: "S3-Compatible Storage", description: "Consume this org's storage from AWS S3-compatible tools." },
    executive: { title: "Executive", description: "A leadership-level summary across every department." },
    dataRooms: { title: "Data Rooms", description: "Secure, time-limited document sharing with outside parties." },
    cloudBackup: { title: "Cloud Backup", description: "Recurring, incremental backups of your own cloud storage into Inaya, with health monitoring." },
    enterpriseHardening: { title: "Export & Migration", description: "Export company data and manage migration tooling." },
    approvals: { title: "Approvals", description: "Documents awaiting your review." },
    aiActions: { title: "AI Action Requests", description: "AI-proposed changes awaiting human approval." },
    evidence: { title: "Evidence", description: "Business Events connecting invoices, purchase orders, and AI decisions into one traceable, provable story." },
    whatIf: { title: "What-If Studio", description: "Model a business disruption using your organization's own real data — read-only, before anything real changes." },
    auditTrail: { title: "Audit Trail", description: "A cryptographically hash-chained, self-verifiable record of activity." },
    complianceEvidence: { title: "Compliance Evidence", description: "Downloadable evidence packages built from this company's own existing storage protection and audit records." },
    trustRelationships: { title: "Cross-Org Trust", description: "Trust relationships with other Inaya organizations." },
    activity: { title: "Activity", description: "The org-wide activity feed." },
    ai: { title: "AI Assistant", description: "Ask about this company's real data, grounded and permission-scoped." },
    billing: { title: "Billing", description: "Plan, usage, and payment details." },
    settings: { title: "Settings", description: "Company type, AI features, team, and departments." },
  };

  return (
    <div className="flex min-h-screen bg-[var(--inaya-bg)] text-[var(--inaya-text-primary)] relative z-0">
      <GlobeBackground variant="subtle" />
      <div className="pointer-events-none fixed top-0 right-0 w-[36rem] h-[36rem] rounded-full bg-gradient-to-br from-[#00f2fe]/5 via-violet-500/5 to-transparent blur-3xl -z-10" aria-hidden="true" />
      {/* Hidden on the dedicated AI Assistant tab itself -- showing the
          floating bubble/panel on top of that full page would be redundant. */}
      {activeView !== "ai" && (
        <AIWidget orgId={orgId} currentView={activeView} guidedTask={guidedTask} onGuidedTaskChange={setGuidedTask} voiceEnabled={!!orgAiPolicy?.voiceEnabled} />
      )}
      <Sidebar
        orgName={membership.orgName}
        role={role}
        activeView={activeView}
        onNavigate={navigate}
        canManage={canManage}
        vertical={orgVertical}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-[var(--inaya-bg)]/90 backdrop-blur border-b border-[var(--inaya-border)] px-5 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => setMobileNavOpen(true)} className="md:hidden text-[var(--inaya-text-primary)] p-1">
              <Icon path={<path d="M4 6h16M4 12h16M4 18h16" />} />
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold text-[var(--inaya-text-primary)] tracking-tight truncate">{VIEW_TITLES[activeView]?.title}</h1>
              <p className="text-[var(--inaya-text-muted)] text-[13px] truncate" title={email}>{VIEW_TITLES[activeView]?.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CommandPalette searchUrl={`/api/orgs/search?orgId=${membership.orgId}`} onSelect={(r) => navigate(r.view)} />
            <NotificationsBell scope="org" orgId={membership.orgId} email={email} />
            <ThemeSwitcher />
            <a
              href="/docs/business-workspace-guide.md"
              download
              className="hidden sm:inline-block text-[12px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-slate-300 px-2 py-2"
              title="Download the step-by-step setup guide"
            >
              ↓ Guide
            </a>
            <a
              href="/business/download"
              className="hidden sm:inline-block text-[12px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-slate-300 px-2 py-2"
              title="Get the Business Workspace desktop app"
            >
              🖥️ Desktop App
            </a>
            <a
              href="/"
              className="hidden sm:inline-block text-[12px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-slate-300 px-2 py-2"
              title="Back to the Inaya Network dApp"
            >
              ← dApp
            </a>
            {orgs.length > 1 && (
              <select
                value={selectedOrgId || ""}
                onChange={(e) => onSwitchOrg(e.target.value)}
                className="bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]"
              >
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>{o.orgName}</option>
                ))}
              </select>
            )}
            <button onClick={onLogout} className="text-[12px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-3 py-2 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)]">
              Sign out
            </button>
          </div>
        </header>

        <main className="p-5 md:p-8 max-w-6xl">
          {activeView === "osHome" && <OsHomeView onNavigate={navigate} />}
          {activeView === "insights" && <InsightsView orgId={orgId} canManage={canManage} onNavigate={navigate} />}
          {activeView === "brief" && <BriefView orgId={orgId} />}
          {activeView === "whatChanged" && <ActivityCenterView baseUrl={`/api/orgs/activity-center?orgId=${orgId}`} />}
          {activeView === "security" && <MfaSettings />}
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
          {activeView === "sign" && <SignView orgId={orgId} email={email} />}
          {activeView === "escrow" && <EscrowView orgId={orgId} />}
          {activeView === "storageManager" && <StorageManagerView orgId={orgId} />}
          {activeView === "attestations" && <AttestationsView orgId={orgId} />}
          {activeView === "health" && <HealthView orgId={orgId} canManage={canManage} email={email} />}
          {activeView === "legal" && <LegalView orgId={orgId} canManage={canManage} email={email} />}
          {activeView === "regulated" && <RegulatedView orgId={orgId} canManage={canManage} email={email} />}
          {activeView === "government" && <GovernmentView orgId={orgId} canManage={canManage} email={email} />}
          {activeView === "financial" && <FinancialView orgId={orgId} canManage={canManage} email={email} vertical={orgVertical} />}
          {activeView === "resilience" && <SecurityResilienceView orgId={orgId} email={email} />}
          {activeView === "resilienceTesting" && <ResilienceView orgId={orgId} />}
          {activeView === "integrations" && <IntegrationsView orgId={orgId} email={email} />}
          {activeView === "apiKeys" && <ApiKeysView orgId={orgId} />}
          {activeView === "s3Compat" && <S3CompatView orgId={orgId} />}
          {activeView === "executive" && <ExecutiveDashboardView orgId={orgId} email={email} />}
          {activeView === "dataRooms" && <DataRoomsView orgId={orgId} email={email} />}
          {activeView === "cloudBackup" && canManage && <CloudBackupSchedulerView orgId={orgId} />}
          {activeView === "enterpriseHardening" && <EnterpriseHardeningView orgId={orgId} email={email} />}
          {activeView === "approvals" && canManage && <ApprovalsView orgId={orgId} onNavigate={navigate} />}
          {activeView === "aiActions" && <AIActionRequestsView orgId={orgId} />}
          {activeView === "evidence" && <BusinessEventsView orgId={orgId} />}
          {activeView === "whatIf" && <WhatIfStudioView orgId={orgId} />}
          {activeView === "auditTrail" && canManage && <AuditTrailView orgId={orgId} />}
          {activeView === "complianceEvidence" && canManage && <ComplianceEvidenceView orgId={orgId} />}
          {activeView === "trustRelationships" && canManage && <TrustRelationshipsView orgId={orgId} />}
          {activeView === "activity" && <ActivityView orgId={orgId} />}
          {activeView === "ai" && (
            <AIAssistantView orgId={orgId} currentView={activeView} guidedTask={guidedTask} onGuidedTaskChange={setGuidedTask} voiceEnabled={!!orgAiPolicy?.voiceEnabled} />
          )}
          {activeView === "billing" && canManage && <BillingView orgId={orgId} canManage={canManage} />}
          {activeView === "settings" && canManage && (
            <div className="space-y-6">
              <OrgVerticalSettings orgId={orgId} vertical={orgVertical} onChanged={setOrgVertical} />
              <VoiceAiSettings orgId={orgId} aiPolicy={orgAiPolicy} onChanged={setOrgAiPolicy} />
              <TeamView orgId={orgId} email={email} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD — overview cards + recent departments/projects/documents.
// ============================================================
const STATUS_STYLES = {
  DRAFT: "bg-[var(--inaya-overlay-5)] text-[var(--inaya-text-muted)] border-[var(--inaya-overlay-10)]",
  PENDING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  UNDER_REVIEW: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  ARCHIVED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

// StatCard/DashboardCard/DashboardView removed -- the former separate
// "Dashboard" screen was a redundant second home screen (see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.2); its real, useful content (desktop
// promo, recent departments/projects/documents) was merged into
// OsHomeView.js, which is now the Workspace's single home screen.
// STATUS_STYLES above is kept -- ApprovalsView and OrgWorkspace still use it.

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
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const selectableIds = data.filter((d) => d.status === "UNDER_REVIEW").map((d) => d.id);

  return (
    <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--inaya-text-muted)]">Documents awaiting your review</h3>
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
            <div key={d.id} className="flex items-center justify-between gap-3 bg-black/20 border border-[var(--inaya-overlay-5)] rounded-lg p-3">
              <div className="flex items-center gap-2 min-w-0">
                {d.status === "UNDER_REVIEW" && (
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelected(d.id)} className="shrink-0" />
                )}
                <button onClick={() => onNavigate("documents", { deptId: d.departmentId, projectId: d.projectId })} className="min-w-0 text-left">
                  <p className="text-[var(--inaya-text-primary)] text-sm truncate">{d.filename}</p>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono">{d.departmentName} · {d.projectName}</p>
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
  if (!activity) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const capped = activity.slice(0, ACTIVITY_FEED_CAP);

  return (
    <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] mb-4">Recent activity</h3>
      {activity.length === 0 ? (
        <EmptyState compact icon="📜" description="No activity recorded yet — actions on documents in this org will show up here." />
      ) : (
        <div className="space-y-2.5">
          {activity.length > ACTIVITY_FEED_CAP && <p className="text-[11px] font-mono text-[#8a96ab]">Showing latest {ACTIVITY_FEED_CAP} of {activity.length}.</p>}
          {capped.map((e) => (
            <div key={e.eventId} className="text-xs border-b border-[var(--inaya-overlay-5)] pb-2.5 last:border-0 last:pb-0">
              <span className="text-[var(--inaya-text-primary)] font-bold">{e.filename}</span>
              <span className="text-[var(--inaya-text-muted)]"> · {e.action}</span>
              {e.previousState && <span className="text-[var(--inaya-text-muted)] font-mono"> · {e.previousState} → {e.newState}</span>}
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

function AIAssistantView({ orgId, currentView, guidedTask, onGuidedTaskChange, voiceEnabled = false }) {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi — ask me about your company's departments, projects, documents, or recent activity, or tell me a task you want to do and I'll walk you through it step by step." },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Inaya AI Voice Assistant SOW -- voiceEnabled comes from the parent's
  // orgAiPolicy state (see AIWidget.js's identical fix for why this isn't
  // fetched independently here anymore), never trusted as the real
  // authorization boundary either way.

  async function send(text) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || sending) return;
    const nextMessages = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);
    setError("");
    try {
      const data = await api("/api/ai/business-chat", { method: "POST", body: JSON.stringify({ orgId, messages: nextMessages, currentView }) });
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      // A guided-task tool call (start/advance/pause/cancel) may have
      // changed state server-side without the client's own step-complete
      // endpoint being involved -- re-check so the panel stays in sync
      // with whatever the model just did.
      api(`/api/orgs/guided-tasks?orgId=${orgId}`).then((d) => onGuidedTaskChange(d.tasks?.[0] || null)).catch(() => {});
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  const handleVoiceToolCall = useCallback(async (toolName, args) => {
    const data = await api("/api/ai/voice-tool-relay", { method: "POST", body: JSON.stringify({ orgId, toolName, args, currentView }) });
    api(`/api/orgs/guided-tasks?orgId=${orgId}`).then((d) => onGuidedTaskChange(d.tasks?.[0] || null)).catch(() => {});
    return data.result;
  }, [orgId, currentView, onGuidedTaskChange]);

  const handleVoiceTranscriptEntry = useCallback((entry) => {
    setMessages((prev) => [...prev, { role: entry.role, content: entry.text }]);
  }, []);

  return (
    <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5 flex flex-col" style={{ height: "calc(100vh - 180px)", minHeight: 420 }}>
      {guidedTask && <GuidedTaskPanel orgId={orgId} task={guidedTask} onTaskChange={onGuidedTaskChange} />}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                m.role === "user" ? "bg-[#00f2fe]/15 text-[var(--inaya-text-primary)]" : "bg-[var(--inaya-overlay-5)] text-[var(--inaya-text-primary)]"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[var(--inaya-overlay-5)] text-[var(--inaya-text-muted)] rounded-2xl px-4 py-2.5 text-sm italic">Thinking…</div>
          </div>
        )}
      </div>

      {messages.length <= 1 && (
        <div className="flex flex-wrap gap-2 py-3 border-t border-[var(--inaya-overlay-5)] mt-3">
          {AI_SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(s)} className="text-[12px] text-[var(--inaya-text-primary)] bg-[var(--inaya-overlay-5)] hover:bg-[var(--inaya-overlay-10)] border border-[var(--inaya-overlay-10)] rounded-full px-3 py-1.5">
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--inaya-overlay-5)]">
        <VoiceAssistantControl
          orgId={orgId}
          currentView={currentView}
          onToolCall={handleVoiceToolCall}
          onTranscriptEntry={handleVoiceTranscriptEntry}
          enabled={voiceEnabled}
        />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about your company's documents, approvals, or activity…"
          disabled={sending}
          className="flex-1 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-2.5 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]"
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
              <p className="text-[var(--inaya-text-muted)] text-xs text-center mt-1">
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
    <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--inaya-text-muted)]">{title}</h3>
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finance" autoFocus className="flex-1 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
          <button className="text-[12px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 rounded-lg">Add</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[12px] mb-2">{error}</p>}
      {departments.length === 0 ? (
        <EmptyState compact icon="🏢" description="No departments yet." ctaLabel={canManage ? "+ Create one" : undefined} onCta={canManage ? () => setCreating(true) : undefined} />
      ) : (
        <div className="space-y-1">
          {departments.map((d) => (
            <button key={d.id} onClick={() => onSelect(d.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedDeptId === d.id ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-5)]"}`}>
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Audit" autoFocus className="flex-1 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
          <button className="text-[12px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 rounded-lg">Add</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[12px] mb-2">{error}</p>}
      {projects.length === 0 ? (
        <EmptyState compact icon="📁" description="No projects yet." ctaLabel={canManage ? "+ Create one" : undefined} onCta={canManage ? () => setCreating(true) : undefined} />
      ) : (
        <div className="space-y-1">
          {projects.map((p) => (
            <button key={p.id} onClick={() => onSelect(p.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedProjectId === p.id ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-5)]"}`}>
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
        <input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder="Encryption passkey" className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
        <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value)} className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]">
          <option value="PRIVATE">Private</option>
          <option value="DEPARTMENT">Department</option>
          <option value="PROJECT">Project</option>
        </select>
        <p className="text-[11px] text-[var(--inaya-text-muted)]">{ACCESS_LEVEL_HINTS[accessLevel]}</p>
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
    <div className="bg-black/20 border border-[var(--inaya-overlay-5)] rounded-lg p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-[var(--inaya-text-primary)] truncate">{doc.filename}</div>
          <div className="text-[12px] text-[var(--inaya-text-muted)] font-mono mt-0.5">{(doc.sizeBytes / 1024).toFixed(1)} KB · {doc.uploadedByEmail}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_STYLES[doc.status] || STATUS_STYLES.DRAFT}`}>
            {doc.status.replace("_", " ")}
          </span>
          <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{doc.accessLevel}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {availableActions.map(([action, label]) =>
          action === "archive" ? (
            <ConfirmButton
              key={action}
              onConfirm={() => handleAction(action)}
              disabled={!!acting}
              className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40"
            >
              {acting === action ? "…" : label}
            </ConfirmButton>
          ) : (
            <button
              key={action}
              onClick={() => handleAction(action)}
              disabled={!!acting}
              className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40"
            >
              {acting === action ? "…" : label}
            </button>
          )
        )}
        <button onClick={() => setShowDownload((v) => !v)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)]">
          Download
        </button>
        {canManageThisDoc && (
          <>
            <button onClick={() => setShowPermissions((v) => !v)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)]">
              Permissions
            </button>
            <button onClick={() => setShowShare((v) => !v)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)]">
              Share
            </button>
          </>
        )}
        <button onClick={toggleActivity} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md text-[var(--inaya-text-muted)] hover:text-slate-300 ml-auto">
          {showActivity ? "Hide history" : "History"}
        </button>
      </div>

      {error && <p className="text-red-400 text-[12px] mt-1.5">{error}</p>}

      {showDownload && (
        <div className="mt-2 border-t border-[var(--inaya-overlay-5)] pt-2 flex gap-2">
          <input
            type="password"
            value={downloadPasskey}
            onChange={(e) => setDownloadPasskey(e.target.value)}
            placeholder="Encryption passkey"
            className="flex-1 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]"
          />
          <button onClick={handleDownload} disabled={downloading || !downloadPasskey} className="text-[11px] font-bold uppercase px-3 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            {downloading ? "…" : "Go"}
          </button>
        </div>
      )}

      {showPermissions && <PermissionsPanel documentId={doc.id} orgId={orgId} ownerEmail={doc.uploadedByEmail} />}
      {showShare && <SharePanel documentId={doc.id} orgId={orgId} />}

      {showActivity && (
        <div className="mt-2 border-t border-[var(--inaya-overlay-5)] pt-2 space-y-1">
          {loadingActivity ? (
            <p className="text-[#8a96ab] text-[12px] italic">Loading…</p>
          ) : activity && activity.length > 0 ? (
            activity.map((e) => (
              <div key={e.eventId} className="text-[12px] font-mono text-[var(--inaya-text-muted)]">
                <span className="text-[var(--inaya-text-primary)]">{e.action}</span>
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
    <div className="mt-2 border-t border-[var(--inaya-overlay-5)] pt-2">
      <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1.5">People with access</p>
      <div className="flex items-center justify-between text-[12px] py-1">
        <span className="text-[var(--inaya-text-primary)] truncate">{ownerEmail}</span>
        <span className="text-[var(--inaya-text-muted)] font-mono">Owner</span>
      </div>
      {grants === null ? (
        <p className="text-[#8a96ab] text-[12px] italic">Loading…</p>
      ) : (
        grants.map((g) => (
          <div key={g.email} className="flex items-center justify-between gap-2 text-[12px] py-1">
            <span className="text-[var(--inaya-text-primary)] truncate">{g.email}</span>
            <div className="flex items-center gap-1 shrink-0">
              <select value={g.level} onChange={(e) => handleChange(g.email, e.target.value)} className="bg-black/45 border border-[var(--inaya-overlay-15)] rounded px-1 py-0.5 text-[11px] text-[var(--inaya-text-primary)]">
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
        <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" required placeholder="Add person by email" className="flex-1 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[12px] text-[var(--inaya-text-primary)]" />
        <select value={newLevel} onChange={(e) => setNewLevel(e.target.value)} className="bg-black/45 border border-[var(--inaya-overlay-15)] rounded px-1 py-1 text-[11px] text-[var(--inaya-text-primary)]">
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
    <div className="mt-2 border-t border-[var(--inaya-overlay-5)] pt-2">
      <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1.5">Secure sharing</p>
      <form onSubmit={handleCreate} className="flex items-center gap-1.5">
        <select value={preset} onChange={(e) => setPreset(e.target.value)} className="bg-black/45 border border-[var(--inaya-overlay-15)] rounded px-1.5 py-1 text-[11px] text-[var(--inaya-text-primary)]">
          <option value="1h">Expires in 1 hour</option>
          <option value="24h">Expires in 24 hours</option>
          <option value="7d">Expires in 7 days</option>
          <option value="30d">Expires in 30 days</option>
        </select>
        <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} type="number" min="1" placeholder="Max uses (optional)" className="w-28 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[12px] text-[var(--inaya-text-primary)]" />
        <button disabled={creating} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
          {creating ? "…" : "Create link"}
        </button>
      </form>

      {newShareUrl && (
        <div className="mt-2 bg-black/20 border border-[var(--inaya-overlay-10)] rounded-lg p-2">
          <p className="text-[11px] text-[var(--inaya-text-muted)] mb-1">Share this link — it won't be shown again:</p>
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
              <span className="text-[var(--inaya-text-primary)]">
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
        <p className="text-[var(--inaya-text-muted)] text-[12px] font-bold uppercase tracking-wide">{label}</p>
        <p className="text-[var(--inaya-text-primary)] text-xs font-mono">{unlimited ? `${used}${unit} · Unlimited` : `${used}${unit} / ${max}${unit}`}</p>
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
    return <p className="text-[var(--inaya-text-muted)] text-sm">{error || "Loading…"}</p>;
  }

  const { plan, usage, subscription, availablePlans } = data;

  return (
    <div className="space-y-6">
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <p className="text-[var(--inaya-text-muted)] text-[12px] font-bold uppercase tracking-wide">Current plan</p>
            <p className="text-[var(--inaya-text-primary)] text-xl font-extrabold">{plan.name}</p>
            {subscription && (
              <p className="text-[var(--inaya-text-muted)] text-[13px] font-mono mt-0.5">
                {subscription.status}
                {subscription.currentPeriodEnd ? ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ""}
              </p>
            )}
          </div>
          {subscription && (
            <button
              onClick={handlePortal}
              disabled={portalLoading}
              className="text-[12px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-3 py-2 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40"
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
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--inaya-text-muted)]">Change plan</h3>
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
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] mb-4">Invite someone</h3>
        <form onSubmit={handleInvite} className="space-y-3">
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required type="email" placeholder="colleague@company.com" className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <div>
            <p className="text-[12px] text-[var(--inaya-text-muted)] uppercase mb-1.5">Departments</p>
            <div className="flex flex-wrap gap-1.5">
              {departments.map((d) => (
                <button type="button" key={d.id} onClick={() => toggleDept(d.id)} className={`text-[12px] px-2.5 py-1 rounded-full border ${inviteDeptIds.includes(d.id) ? "bg-[#00f2fe]/15 border-[#00f2fe]/40 text-[#00f2fe]" : "border-[var(--inaya-overlay-10)] text-slate-400"}`}>
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
          <div className="mt-3 bg-black/20 border border-[var(--inaya-overlay-10)] rounded-lg p-3">
            <p className="text-slate-400 text-xs mb-1">{inviteResult.emailSent ? "Invite emailed." : "Share this invite link:"}</p>
            <a href={inviteResult.inviteUrl} className="text-[#00f2fe] underline text-[12px] break-all">{inviteResult.inviteUrl}</a>
          </div>
        )}
      </div>

      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] mb-4">Members</h3>

        {ownMembership && (ownMembership.role === "owner" || ownMembership.role === "admin") && (
          <div className="flex items-center justify-between gap-3 bg-black/20 border border-[var(--inaya-overlay-5)] rounded-lg p-3 mb-3">
            <div className="min-w-0">
              <p className="text-xs text-[var(--inaya-text-primary)]">Email me when something needs my approval</p>
              <p className="text-[12px] text-[var(--inaya-text-muted)] mt-0.5">Sent the moment a document is submitted — you can turn this off if it's too noisy.</p>
            </div>
            <button
              onClick={() => handleToggleNotify(!ownMembership.notifyOnApprovals)}
              disabled={savingNotifyPref}
              className={`shrink-0 relative w-10 h-6 rounded-full transition-colors disabled:opacity-40 ${ownMembership.notifyOnApprovals ? "bg-[#00f2fe]/60" : "bg-[var(--inaya-overlay-10)]"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${ownMembership.notifyOnApprovals ? "translate-x-[18px]" : "translate-x-0.5"}`} />
            </button>
          </div>
        )}

        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.email} className="flex items-center justify-between bg-black/20 border border-[var(--inaya-overlay-5)] rounded-lg p-2.5">
              <div className="min-w-0">
                <div className="text-xs text-[var(--inaya-text-primary)] truncate">{m.email}</div>
                <div className="text-[12px] text-[var(--inaya-text-muted)] font-mono">{ROLE_LABELS[m.role]} · {m.status === "active" ? "Active" : "Invited"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
