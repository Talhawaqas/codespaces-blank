"use client";

// app/admin/hackathon/page.js
//
// Hackathon admin — the operator side of what HackathonSection.js shows
// publicly. Same passphrase-gated session as every other /admin/* page
// (src/lib/admin-auth.js). Two concerns:
//
//   Winners  — assign a wallet address to each of the 6 fixed prize slots
//              (POST/DELETE /api/hackathon/winners) so the public tab and
//              (eventually) configureWinnersBatch() at mainnet have real
//              data to read.
//   Reports  — triage incoming bug reports (GET /api/hackathon/bug-reports,
//              PATCH .../[id]) -- status/finalSeverity/notes. Before this
//              page existed, triage was curl-only; this is just a UI over
//              routes that were already live and working.
//
// hackathon.js has zero server-only imports (db is always passed in, never
// imported), so its constants are safe to import directly into this
// "use client" page -- same as HackathonSection.js already does.

import { useState, useEffect, useCallback } from "react";
import { PRIZE_SLOTS, IN_SCOPE_LAYERS, SEVERITY_LEVELS } from "../../../lib/hackathon";

const REPORT_STATUSES = ["submitted", "confirmed", "duplicate", "rejected", "fixed"];
const STATUS_COLORS = {
  submitted: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  confirmed: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  duplicate: "text-[#64748b] border-white/10 bg-white/5",
  rejected: "text-red-400 border-red-400/30 bg-red-400/10",
  fixed: "text-[#00f2fe] border-[#00f2fe]/30 bg-[#00f2fe]/10",
};

function layerLabel(id) {
  return IN_SCOPE_LAYERS.find((l) => l.id === id)?.label || id;
}
function severityLabel(id) {
  return SEVERITY_LEVELS.find((s) => s.id === id)?.label || id;
}
function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}
function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function HackathonAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [tab, setTab] = useState("winners"); // winners | reports
  const [winners, setWinners] = useState([]);
  const [reports, setReports] = useState([]);
  const [loadError, setLoadError] = useState("");

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const [winnersRes, reportsRes] = await Promise.all([
        fetch("/api/hackathon/winners"),
        fetch("/api/hackathon/bug-reports"),
      ]);
      if (!winnersRes.ok || !reportsRes.ok) throw new Error("Session may have expired — please log in again.");
      setWinners((await winnersRes.json()).winners);
      setReports((await reportsRes.json()).reports);
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    if (authed) loadData();
  }, [authed, loadData]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoginError(data.error || "Login failed.");
        return;
      }
      setAuthed(true);
      setPassphrase("");
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveWinner(place, walletAddress, projectName) {
    try {
      const res = await fetch("/api/hackathon/winners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place, walletAddress, projectName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save winner.");
      setWinners(data.winners);
    } catch (err) {
      alert(err.message);
    }
  }

  async function clearWinner(place) {
    if (!window.confirm(`Clear the winner recorded for ${place}?`)) return;
    try {
      const res = await fetch(`/api/hackathon/winners/${place}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear winner.");
      setWinners(data.winners);
    } catch (err) {
      alert(err.message);
    }
  }

  async function updateReport(id, patch) {
    try {
      const res = await fetch(`/api/hackathon/bug-reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update report.");
      setReports((prev) => prev.map((r) => (r.id === id ? data.report : r)));
    } catch (err) {
      alert(err.message);
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Hackathon Admin</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3"
            placeholder="Passphrase"
            autoFocus
          />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50"
          >
            {loading ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  const openReportsCount = reports.filter((r) => r.status === "submitted").length;

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-white">Hackathon</h1>
            <p className="text-[#64748b] text-xs mt-0.5">Sept 1 – Nov 1, 2026 · 100,000 INAYA prize pool</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/admin" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
              ← Dashboard
            </a>
            <button onClick={loadData} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
              Refresh
            </button>
          </div>
        </div>

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}

        <div className="flex gap-2 mb-6">
          {[
            ["winners", `Winners (${winners.filter((w) => w.walletAddress).length}/6)`],
            ["reports", `Bug Reports (${reports.length}${openReportsCount ? `, ${openReportsCount} new` : ""})`],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${tab === id ? "text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40" : "text-[#64748b] border border-white/5 hover:text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "winners" && (
          <div className="space-y-3">
            {PRIZE_SLOTS.map((slot) => {
              const winner = winners.find((w) => w.place === slot.place) || {};
              return <WinnerRow key={slot.place} slot={slot} winner={winner} onSave={saveWinner} onClear={clearWinner} />;
            })}
          </div>
        )}

        {tab === "reports" && (
          <div className="space-y-2">
            {reports.map((r) => (
              <ReportRow key={r.id} report={r} onUpdate={updateReport} />
            ))}
            {reports.length === 0 && <p className="text-[#64748b] text-sm">No bug reports submitted yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function WinnerRow({ slot, winner, onSave, onClear }) {
  const [walletAddress, setWalletAddress] = useState(winner.walletAddress || "");
  const [projectName, setProjectName] = useState(winner.projectName || "");
  const [saving, setSaving] = useState(false);

  const dirty = walletAddress !== (winner.walletAddress || "") || projectName !== (winner.projectName || "");

  async function handleSave() {
    setSaving(true);
    await onSave(slot.place, walletAddress.trim(), projectName.trim());
    setSaving(false);
  }

  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 flex items-center gap-3 flex-wrap">
      <div className="w-40 shrink-0">
        <p className="text-white text-sm font-semibold">{slot.label}</p>
        <p className="text-[#00f2fe] text-xs font-mono">{slot.amount.toLocaleString()} INAYA</p>
      </div>
      <input
        value={walletAddress}
        onChange={(e) => setWalletAddress(e.target.value)}
        placeholder="0x… winner wallet address"
        className="flex-1 min-w-[220px] bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2 text-xs text-white font-mono outline-none"
      />
      <input
        value={projectName}
        onChange={(e) => setProjectName(e.target.value)}
        placeholder="Label (optional)"
        className="w-40 bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2 text-xs text-white outline-none"
      />
      <button
        onClick={handleSave}
        disabled={saving || !dirty || !walletAddress.trim()}
        className="text-xs font-bold px-3 py-2 bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 rounded-lg disabled:opacity-30"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {winner.walletAddress && (
        <button onClick={() => onClear(slot.place)} className="text-xs font-bold px-3 py-2 text-[#64748b] hover:text-red-400 border border-white/10 rounded-lg">
          Clear
        </button>
      )}
      {winner.claimed && <span className="text-[10px] font-bold text-emerald-400 uppercase">Claimed</span>}
    </div>
  );
}

function ReportRow({ report, onUpdate }) {
  const [notes, setNotes] = useState(report.triageNotes || "");
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <button onClick={() => setExpanded((v) => !v)} className="text-left flex-1 min-w-[240px]">
          <p className="text-white text-sm font-semibold">{report.title}</p>
          <p className="text-[#64748b] text-[11px] font-mono mt-0.5">
            {layerLabel(report.layer)} · {severityLabel(report.finalSeverity || report.severity)}
            {report.finalSeverity && report.finalSeverity !== report.severity && (
              <span className="text-amber-400"> (reported as {severityLabel(report.severity)})</span>
            )}
            {" · "}
            {shortAddr(report.walletAddress)} · {formatDate(report.createdAt)}
          </p>
        </button>
        <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full border shrink-0 ${STATUS_COLORS[report.status] || STATUS_COLORS.submitted}`}>
          {report.status}
        </span>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-white/5 space-y-3">
          <p className="text-slate-300 text-xs whitespace-pre-wrap">{report.description}</p>
          {report.stepsToReproduce && (
            <div>
              <p className="text-[#64748b] text-[10px] font-bold uppercase mb-1">Steps to reproduce</p>
              <p className="text-slate-300 text-xs whitespace-pre-wrap">{report.stepsToReproduce}</p>
            </div>
          )}
          {report.evidenceUrl && (
            <a href={report.evidenceUrl} target="_blank" rel="noreferrer" className="text-[#00f2fe] text-xs hover:underline break-all">
              {report.evidenceUrl} ↗
            </a>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {REPORT_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => onUpdate(report.id, { status: s })}
                disabled={report.status === s}
                className={`text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-full border ${report.status === s ? "opacity-40 cursor-default" : "hover:bg-white/5"} ${STATUS_COLORS[s]}`}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {SEVERITY_LEVELS.map((s) => (
              <button
                key={s.id}
                onClick={() => onUpdate(report.id, { finalSeverity: s.id })}
                disabled={(report.finalSeverity || report.severity) === s.id}
                className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg border ${(report.finalSeverity || report.severity) === s.id ? "text-white bg-white/10 border-white/20" : "text-[#64748b] border-white/10 hover:text-slate-300"}`}
              >
                Set severity: {s.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Triage notes (internal only)"
              className="flex-1 bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2 text-xs text-white outline-none"
            />
            <button
              onClick={() => onUpdate(report.id, { triageNotes: notes })}
              disabled={notes === (report.triageNotes || "")}
              className="text-xs font-bold px-3 py-2 bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 rounded-lg disabled:opacity-30"
            >
              Save notes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
