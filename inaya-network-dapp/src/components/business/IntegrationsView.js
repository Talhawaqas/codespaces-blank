"use client";

// src/components/business/IntegrationsView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 7 (§95, §151, §155,
// §235-238) — Integrations. Cross-vertical, same self-contained-view
// pattern as SecurityResilienceView.js. Two tabs: Connections (the
// catalog + real connection state machine) and Data Quality (scores +
// alerts, honestly "unknown" for anything unsynced).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLES = {
  NOT_CONFIGURED: "border-white/10 text-[var(--inaya-text-muted)]",
  AWAITING_CREDENTIALS: "border-amber-400/30 text-amber-400",
  ACTIVE: "border-emerald-400/30 text-emerald-400",
  ERROR: "border-red-400/30 text-red-400",
  DISABLED: "border-white/10 text-[var(--inaya-text-muted)]",
};

export default function IntegrationsView({ orgId, email }) {
  const [tab, setTab] = useState("connections");
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
        {["connections", "data quality"].map((t) => {
          const key = t.replace(/ /g, "");
          return <button key={t} onClick={() => setTab(key)} className={`px-3.5 py-2 text-[11px] font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{t}</button>;
        })}
      </div>
      {tab === "connections" && <ConnectionsTab orgId={orgId} actorEmail={email} />}
      {tab === "dataquality" && <DataQualityTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// CONNECTIONS (§95, §235-236)
// ============================================================
function ConnectionsTab({ orgId, actorEmail }) {
  const [integrations, setIntegrations] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null); // { providerId, text } -- transient, cleared on next action
  const [oidcForm, setOidcForm] = useState(null); // { providerId, issuer, clientId, clientSecret } -- open config form

  const load = useCallback(async () => {
    try {
      setError("");
      setIntegrations((await api(`/api/orgs/integrations?orgId=${orgId}`)).integrations);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  // Real OAuth connect/disconnect land back here as a full-page redirect
  // (see oauth/callback/route.js) since the browser must leave the page to
  // reach the provider's own login -- read the result out of the URL once,
  // then clean it up so a refresh doesn't re-show a stale notice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const oauthError = params.get("oauthError");
    if (connected) setNotice({ providerId: connected, text: "Connected — this is a real, verified live connection to the provider." });
    if (oauthError) setError(oauthError);
    if (connected || oauthError) {
      params.delete("connected"); params.delete("oauthError");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }, []);

  // DEFECT FIX (Business Workspace Integrations Test SOW, live testing):
  // clicking "Configure" used to just flip the status badge with no
  // visible confirmation of what happened or what to do next -- a real
  // user reported it looked like the click "did nothing." This now shows
  // an explicit, immediate notice stating plainly that connecting here
  // records intent only and does not perform a live sync, right where the
  // user just clicked, instead of leaving them to discover that honesty
  // disclaimer only by expanding the row afterward.
  async function configure(providerId, wasDisabled) {
    try {
      setError(""); setNotice(null);
      await api("/api/orgs/integrations", { method: "POST", body: JSON.stringify({ orgId, providerId, ownerEmail: actorEmail }) });
      setNotice({
        providerId,
        text: wasDisabled
          ? "Re-enabled — this provider is Awaiting Credentials again. No live connection has been made yet; a real sync must run before this shows Active."
          : "Recorded — this provider is now Awaiting Credentials. No live connection has been made yet; a real sync must run before this shows Active.",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(providerId, action) {
    try {
      setError(""); setNotice(null);
      await api(`/api/orgs/integrations/${providerId}`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  // Real OAuth connect -- a full-page navigation, not a fetch, because the
  // browser has to actually leave the page to reach the provider's own
  // login screen and come back with a code. See oauth/start/route.js.
  function connectOauth(providerId) {
    window.location.href = `/api/orgs/integrations/${providerId}/oauth/start?orgId=${orgId}`;
  }

  async function saveOidcConfigAndConnect() {
    if (!oidcForm) return;
    try {
      setError("");
      await api(`/api/orgs/integrations/${oidcForm.providerId}/oauth/config`, {
        method: "POST",
        body: JSON.stringify({ orgId, issuer: oidcForm.issuer, clientId: oidcForm.clientId, clientSecret: oidcForm.clientSecret }),
      });
      setOidcForm(null);
      connectOauth(oidcForm.providerId);
    } catch (err) {
      setError(err.message);
    }
  }

  // Real disconnect: calls the provider's own revoke() (see each adapter's
  // revoke()) before marking DISABLED. When the provider can't confirm the
  // revoke went through (e.g. Microsoft's tenant-policy-dependent grant
  // delete), the response carries manualRevokeUrl -- shown here rather
  // than silently treating "we discarded our copy" as "fully revoked."
  async function disconnectOauth(providerId) {
    try {
      setError(""); setNotice(null);
      const result = await api(`/api/orgs/integrations/${providerId}/oauth/disconnect`, { method: "POST", body: JSON.stringify({ orgId }) });
      setNotice({
        providerId,
        text: result.manualRevokeUrl
          ? `Disconnected here. Could not confirm the access grant was revoked on the provider's side${result.note ? ` (${result.note})` : ""} — finish it yourself at ${result.manualRevokeUrl}`
          : "Disconnected — the access grant was revoked on the provider's side too.",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!integrations) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const byCategory = integrations.reduce((acc, i) => { (acc[i.category] ||= []).push(i); return acc; }, {});

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {Object.entries(byCategory).map(([category, items]) => (
        <div key={category} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">{category.replace(/_/g, " ")}</p>
          <div className="space-y-2">
            {items.map((i) => (
              <div key={i.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <button onClick={() => setExpanded(expanded === i.id ? null : i.id)} className="text-left min-w-0">
                    <span className="text-[var(--inaya-text-primary)] text-sm">{i.name}</span>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[i.status]}`}>{i.status.replace(/_/g, " ")}</span>
                    {i.oauthBacked ? (
                      <>
                        {/* Real OAuth path -- Connect performs a genuine
                            provider login and only reaches ACTIVE after a
                            real API call verifies the token (see
                            integrationOauth.js's completeOauthFlow). */}
                        {(i.status === "NOT_CONFIGURED" || i.status === "DISABLED") && (
                          <button
                            onClick={() => i.requiresOrgConfig ? setOidcForm({ providerId: i.id, issuer: "", clientId: "", clientSecret: "" }) : connectOauth(i.id)}
                            className="text-[10px] font-bold uppercase text-[#00f2fe]"
                          >
                            Connect
                          </button>
                        )}
                        {i.status === "ACTIVE" && <button onClick={() => disconnectOauth(i.id)} className="text-[10px] font-bold uppercase text-red-400">Disconnect</button>}
                        {i.status === "ERROR" && <button onClick={() => connectOauth(i.id)} className="text-[10px] font-bold uppercase text-amber-400">Reconnect</button>}
                        {i.status === "AWAITING_CREDENTIALS" && <button onClick={() => connectOauth(i.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Finish connecting</button>}
                      </>
                    ) : (
                      <>
                        {i.status === "NOT_CONFIGURED" && <button onClick={() => configure(i.id, false)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Configure</button>}
                        {/* DEFECT FIX: DISABLED was previously a dead end -- neither
                            Configure nor Disable rendered for it, so there was no
                            way back in from the UI (matching a real bug report).
                            Re-enabling reuses the same configure() call the
                            backend now honors for a DISABLED connection. */}
                        {i.status === "DISABLED" && <button onClick={() => configure(i.id, true)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Re-enable</button>}
                        {(i.status === "ACTIVE" || i.status === "AWAITING_CREDENTIALS" || i.status === "ERROR") && <button onClick={() => act(i.id, "disable")} className="text-[10px] font-bold uppercase text-red-400">Disable</button>}
                        {i.status === "ERROR" && <button onClick={() => act(i.id, "retry")} className="text-[10px] font-bold uppercase text-amber-400">Retry</button>}
                      </>
                    )}
                  </div>
                </div>
                {i.oauthBacked && i.status === "ACTIVE" && i.externalAccountName && (
                  <p className="mt-1 text-[11px] font-mono text-emerald-400/80">Connected as {i.externalAccountName}</p>
                )}
                {oidcForm?.providerId === i.id && (
                  <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
                    <p className="text-[11px] text-[var(--inaya-text-muted)]">This identity provider needs your own app registration — enter its issuer URL and the client ID/secret you registered for Inaya's callback.</p>
                    <input value={oidcForm.issuer} onChange={(e) => setOidcForm({ ...oidcForm, issuer: e.target.value })} placeholder="https://your-org.okta.com" className="w-full bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--inaya-text-primary)]" />
                    <input value={oidcForm.clientId} onChange={(e) => setOidcForm({ ...oidcForm, clientId: e.target.value })} placeholder="Client ID" className="w-full bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--inaya-text-primary)]" />
                    <input value={oidcForm.clientSecret} onChange={(e) => setOidcForm({ ...oidcForm, clientSecret: e.target.value })} placeholder="Client secret" type="password" className="w-full bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--inaya-text-primary)]" />
                    <div className="flex gap-2">
                      <button onClick={saveOidcConfigAndConnect} className="text-[10px] font-bold uppercase text-[#00f2fe]">Save &amp; connect</button>
                      <button onClick={() => setOidcForm(null)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">Cancel</button>
                    </div>
                  </div>
                )}
                {notice?.providerId === i.id && (
                  <p className="mt-2 text-[11px] text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 rounded-lg px-2.5 py-1.5">{notice.text}</p>
                )}
                {expanded === i.id && (
                  <div className="mt-2 pt-2 border-t border-white/5 text-[11px] font-mono text-[var(--inaya-text-muted)] space-y-1">
                    <p>Auth: {i.authType} · Direction: {i.syncDirection}</p>
                    <p>Credentials: {i.credentialsStatus.replace(/_/g, " ")}</p>
                    {i.status !== "NOT_CONFIGURED" && (
                      <>
                        <p>Owner: {i.ownerEmail || "—"}</p>
                        <p>Last sync: {i.lastSyncAt || "never"} · Next sync: {i.nextSyncAt || "—"}</p>
                        <p>Errors: {i.errorCount} · Records processed: {i.recordsProcessedTotal} · Mismatches: {i.mismatchCountTotal}</p>
                      </>
                    )}
                    {!i.oauthBacked && (i.status === "NOT_CONFIGURED" || i.status === "AWAITING_CREDENTIALS") && (
                      <p className="text-amber-400/80">No live credentials are configured for this provider — connecting it here records intent only, it does not perform a live sync.</p>
                    )}
                    {i.oauthBacked && i.status === "AWAITING_CREDENTIALS" && (
                      <p className="text-amber-400/80">Connect was started but not completed — click &quot;Finish connecting&quot; to try again.</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// DATA QUALITY (§237-238)
// ============================================================
function DataQualityTab({ orgId }) {
  const [scores, setScores] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api(`/api/orgs/data-quality?orgId=${orgId}`),
      api(`/api/orgs/data-quality/alerts?orgId=${orgId}`),
    ]).then(([dq, al]) => { setScores(dq.scores); setAlerts(al.alerts); }).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!scores) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      {alerts && alerts.length > 0 && (
        <div className="bg-amber-400/10 border border-amber-400/30 rounded-xl p-4 space-y-1.5">
          <p className="text-[11px] font-bold uppercase text-amber-400 mb-1">Data quality alerts</p>
          {alerts.map((a, idx) => <p key={idx} className="text-[12px] text-[var(--inaya-text-muted)] font-mono">{a.detail}</p>)}
        </div>
      )}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {scores.length === 0 ? (
          <EmptyState compact icon="📊" description="No integrations configured yet — nothing to score." />
        ) : (
          <div className="space-y-2">
            {scores.map((s) => (
              <div key={s.providerId} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <p className="text-[var(--inaya-text-primary)] text-sm mb-1">{s.providerId.replace(/_/g, " ")}</p>
                {s.reason ? (
                  <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">Unknown — {s.reason}</p>
                ) : (
                  <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono text-[var(--inaya-text-muted)]">
                    <span>Completeness: {s.completeness ?? "unknown"}</span>
                    <span>Freshness: {s.freshness ?? "unknown"}</span>
                    <span>Consistency: {s.consistency ?? "unknown"}</span>
                    <span>Validity: {s.validity ?? "unknown"}</span>
                    <span>Uniqueness: {s.uniqueness ?? "unknown"}</span>
                    <span>Lineage: {s.lineage ?? "unknown"}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
