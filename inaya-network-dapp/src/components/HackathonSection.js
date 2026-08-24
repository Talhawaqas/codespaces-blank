// src/components/HackathonSection.js
//
// "Hackathon" tab — self-contained, same pattern as ReferralSection.js
// (no dependency folded into page.js's giant shared state blob).
//
// Two data sources, deliberately layered:
//   1. GET /api/hackathon/status — always available, DB-recorded prize
//      pool + winners. This is the source of truth before mainnet and
//      before InayaHackathonRewards is even deployed.
//   2. The deployed contract itself, read directly via ethers, ONLY once
//      NEXT_PUBLIC_HACKATHON_REWARDS_ADDRESS is set (it isn't yet — rewards
//      are Mainnet-only per the SOW, and mainnet hasn't launched). Once set,
//      allocation/claimed/mainnetActive reads switch to on-chain truth and
//      the claim button lights up for a connected, unclaimed winner.
//
// Rewards are NEVER claimable on testnet: activateMainnet() on the contract
// itself hard-reverts on any chain id other than 56 (BSC Mainnet), so there
// is no frontend state that can put a real claim through early.

'use client';

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import EmptyState from './EmptyState';
import {
  HACKATHON_TIMELINE,
  IN_SCOPE_LAYERS,
  SEVERITY_LEVELS,
  RESPONSIBLE_DISCLOSURE_NOTICE,
  JUDGING_NOTES,
  ELIGIBILITY_NOTES,
} from '../lib/hackathon';

const HACKATHON_REWARDS_ADDRESS = process.env.NEXT_PUBLIC_HACKATHON_REWARDS_ADDRESS || '';

const HACKATHON_REWARDS_ABI = [
  'function allocations(address) view returns (uint256)',
  'function claimed(address) view returns (bool)',
  'function mainnetActive() view returns (bool)',
  'function claim() external',
];

const REPORT_STATUS_LABELS = {
  submitted: { label: 'Submitted', color: 'text-amber-400' },
  confirmed: { label: 'Confirmed', color: 'text-emerald-400' },
  duplicate: { label: 'Duplicate', color: 'text-[#64748b]' },
  rejected: { label: 'Rejected', color: 'text-red-400' },
  fixed: { label: 'Fixed', color: 'text-emerald-400' },
};

const EMPTY_REPORT_FORM = { title: '', layer: IN_SCOPE_LAYERS[0].id, severity: 'medium', description: '', stepsToReproduce: '', evidenceUrl: '' };

function truncateAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function buildHackathonReportMessage({ title, layer, severity, timestamp }) {
  return ['Inaya Hackathon Bug Report', `title: ${title}`, `layer: ${layer}`, `severity: ${severity}`, `timestamp: ${timestamp}`].join('\n');
}

export default function HackathonSection({ walletAddress, getActiveProvider }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [onChain, setOnChain] = useState(null); // { allocation, claimed, mainnetActive } once contract address exists
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [claimSuccess, setClaimSuccess] = useState(false);

  const [reportForm, setReportForm] = useState(EMPTY_REPORT_FORM);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const [reportSuccessId, setReportSuccessId] = useState('');
  const [myReports, setMyReports] = useState([]);
  const [myReportsLoading, setMyReportsLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/hackathon/status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load hackathon status.');
      setStatus(data);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load hackathon status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const fetchMyReports = useCallback(async () => {
    if (!walletAddress) {
      setMyReports([]);
      return;
    }
    try {
      setMyReportsLoading(true);
      const res = await fetch(`/api/hackathon/my-reports?walletAddress=${walletAddress}`);
      const data = await res.json();
      if (res.ok) setMyReports(data.reports || []);
    } catch (err) {
      console.error('Could not load your bug reports:', err);
    } finally {
      setMyReportsLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => { fetchMyReports(); }, [fetchMyReports]);

  const handleReportFieldChange = (field, value) => {
    setReportForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmitReport = async (e) => {
    e.preventDefault();
    if (!walletAddress) return;
    try {
      setReportBusy(true);
      setReportError('');
      setReportSuccessId('');

      const injected = (getActiveProvider && getActiveProvider()) || (typeof window !== 'undefined' ? window.ethereum : undefined);
      if (!injected) throw new Error('No wallet provider found.');
      const provider = new ethers.BrowserProvider(injected);
      const signer = await provider.getSigner();

      const timestamp = Date.now();
      const { title, layer, severity, description, stepsToReproduce, evidenceUrl } = reportForm;
      const message = buildHackathonReportMessage({ title, layer, severity, timestamp });
      const signature = await signer.signMessage(message);

      const res = await fetch('/api/hackathon/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, layer, severity, description, stepsToReproduce, evidenceUrl, walletAddress, message, signature, timestamp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit report.');

      setReportSuccessId(data.report.id);
      setReportForm(EMPTY_REPORT_FORM);
      fetchMyReports();
    } catch (err) {
      setReportError(err.shortMessage || err.message || 'Could not submit report.');
    } finally {
      setReportBusy(false);
    }
  };

  // On-chain read, only meaningful once a contract is actually deployed.
  useEffect(() => {
    if (!HACKATHON_REWARDS_ADDRESS || !walletAddress) {
      setOnChain(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const injected = (getActiveProvider && getActiveProvider()) || (typeof window !== 'undefined' ? window.ethereum : undefined);
        if (!injected) return;
        const provider = new ethers.BrowserProvider(injected);
        const contract = new ethers.Contract(HACKATHON_REWARDS_ADDRESS, HACKATHON_REWARDS_ABI, provider);
        const [allocation, hasClaimed, mainnetActive] = await Promise.all([
          contract.allocations(walletAddress),
          contract.claimed(walletAddress),
          contract.mainnetActive(),
        ]);
        if (!cancelled) {
          setOnChain({ allocation, claimed: hasClaimed, mainnetActive });
        }
      } catch (err) {
        console.error('Hackathon on-chain read failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, getActiveProvider]);

  const myWinnerEntry = status?.winners?.find(
    (w) => w.walletAddress && walletAddress && w.walletAddress.toLowerCase() === walletAddress.toLowerCase()
  );

  const mainnetActive = onChain ? onChain.mainnetActive : false;
  const alreadyClaimed = onChain ? onChain.claimed : !!myWinnerEntry?.claimed;
  const canClaimOnChain = HACKATHON_REWARDS_ADDRESS && onChain && onChain.allocation > 0n && mainnetActive && !onChain.claimed;

  const handleClaim = async () => {
    if (!HACKATHON_REWARDS_ADDRESS) return;
    try {
      setClaimBusy(true);
      setClaimError('');
      const injected = (getActiveProvider && getActiveProvider()) || (typeof window !== 'undefined' ? window.ethereum : undefined);
      const provider = new ethers.BrowserProvider(injected);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(HACKATHON_REWARDS_ADDRESS, HACKATHON_REWARDS_ABI, signer);
      const tx = await contract.claim();
      await tx.wait();
      setClaimSuccess(true);
      setOnChain((prev) => (prev ? { ...prev, claimed: true } : prev));
    } catch (err) {
      setClaimError(err.shortMessage || err.message || 'Claim failed.');
    } finally {
      setClaimBusy(false);
    }
  };

  if (loading) {
    return <div className="max-w-4xl mx-auto text-center text-[#64748b] text-xs py-16">Loading hackathon status…</div>;
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        <EmptyState icon="⚠️" title="Could not load hackathon status" description={error} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-extrabold text-white">🏆 Hackathon Rewards</h2>
        <p className="text-[#94a3b8] text-sm mt-1">
          {status.totalPool.toLocaleString()} $INAYA Prize Pool — funded from the Node Swarm Reserve allocation, distributed to winners once mainnet launches.
        </p>
      </div>

      {/* RULES — this isn't a "build a project" hackathon: there's nothing to build,
          only real bugs to find across the live ecosystem. */}
      <div className="bg-black/20 border border-white/5 rounded-2xl p-6 space-y-5">
        <div>
          <div className="text-white font-bold text-sm mb-1">📋 What this is</div>
          <p className="text-[#94a3b8] text-xs leading-relaxed">
            No project to build. Explore every layer of the Inaya ecosystem below and report real bugs. Reports are triaged and scored — the strongest reports fill the 6 prize slots.
          </p>
        </div>

        <div>
          <div className="text-white font-bold text-sm mb-2">🧩 In scope</div>
          <div className="flex flex-wrap gap-2">
            {IN_SCOPE_LAYERS.filter((l) => l.id !== 'other').map((l) => (
              <span key={l.id} className="px-3 py-1.5 rounded-full text-[11px] font-mono bg-white/5 border border-white/10 text-[#94a3b8]">{l.label}</span>
            ))}
          </div>
        </div>

        <div>
          <div className="text-white font-bold text-sm mb-2">🚦 Severity guide</div>
          <div className="grid sm:grid-cols-2 gap-2 font-mono text-[11px]">
            {SEVERITY_LEVELS.map((s) => (
              <div key={s.id} className="bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                <span className={s.id === 'critical' ? 'text-red-400 font-bold' : s.id === 'high' ? 'text-amber-400 font-bold' : s.id === 'medium' ? 'text-[#00f2fe] font-bold' : 'text-[#64748b] font-bold'}>{s.label}</span>
                <span className="text-[#64748b]"> — {s.description}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <div className="text-red-400 font-bold text-xs mb-1">⚠️ Responsible disclosure</div>
          <p className="text-[#94a3b8] text-xs leading-relaxed">{RESPONSIBLE_DISCLOSURE_NOTICE}</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <div>
            <div className="text-white font-bold text-sm mb-1">⚖️ Judging</div>
            <p className="text-[#94a3b8] text-xs leading-relaxed">{JUDGING_NOTES}</p>
          </div>
          <div>
            <div className="text-white font-bold text-sm mb-1">✅ Eligibility</div>
            <ul className="text-[#94a3b8] text-xs leading-relaxed list-disc list-inside space-y-0.5">
              {ELIGIBILITY_NOTES.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          </div>
        </div>

        <div className="font-mono text-[11px] text-[#64748b] border-t border-white/5 pt-4">
          Testing window: <span className="text-white">{HACKATHON_TIMELINE.start} – {HACKATHON_TIMELINE.deadline}</span>. Winners announced: {HACKATHON_TIMELINE.winnersAnnounced}
        </div>
      </div>

      <div className="bg-gradient-to-r from-[#0a0f1d] to-[#0b1426] border border-[#00f2fe]/20 rounded-xl p-6 font-mono text-xs space-y-1">
        <div className="text-white font-bold text-sm">Hackathon Rewards — Distributed on Mainnet</div>
        <p className="text-slate-500">
          Winners and allocations are recorded now so rewards can be transferred as soon as mainnet activates. No claim can happen before then — the reward contract itself only unlocks on BSC Mainnet.
        </p>
      </div>

      <div className="bg-black/20 border border-white/5 rounded-2xl overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-white/5 text-[#64748b]">
              <th className="text-left px-4 py-3 font-semibold">Place</th>
              <th className="text-left px-4 py-3 font-semibold">Winner</th>
              <th className="text-right px-4 py-3 font-semibold">Reward</th>
              <th className="text-right px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {status.winners.map((w) => (
              <tr key={w.place} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 text-white">{w.label}</td>
                <td className="px-4 py-3 text-[#94a3b8]">
                  {w.walletAddress
                    ? (w.projectName ? `${w.projectName} — ${truncateAddress(w.walletAddress)}` : truncateAddress(w.walletAddress))
                    : <span className="text-[#475569] italic">To be announced</span>}
                </td>
                <td className="px-4 py-3 text-right text-[#00f2fe] font-bold">{w.amount.toLocaleString()} INAYA</td>
                <td className="px-4 py-3 text-right">
                  {!w.walletAddress ? (
                    <span className="text-[#475569]">—</span>
                  ) : w.claimed ? (
                    <span className="text-emerald-400">Claimed</span>
                  ) : (
                    <span className="text-amber-400">Unclaimed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!walletAddress && (
        <EmptyState compact icon="🔌" description="Connect your wallet to see your own claim status once winners are announced." />
      )}

      {walletAddress && myWinnerEntry?.walletAddress && (
        <div className="bg-gradient-to-r from-emerald-500/10 to-emerald-500/0 border border-emerald-500/30 rounded-xl p-6 space-y-3">
          <div className="text-white font-bold text-sm">🎉 You're a winner — {myWinnerEntry.label}</div>
          <div className="text-[#94a3b8] text-xs">Allocated: <span className="text-emerald-400 font-bold">{myWinnerEntry.amount.toLocaleString()} INAYA</span></div>

          {alreadyClaimed ? (
            <div className="text-emerald-400 text-xs font-mono">✓ Already claimed.</div>
          ) : !HACKATHON_REWARDS_ADDRESS ? (
            <div className="text-[#64748b] text-xs font-mono">Reward contract not yet deployed — claiming opens once mainnet launches.</div>
          ) : !mainnetActive ? (
            <button disabled className="px-5 py-2 rounded-full text-xs font-mono font-bold bg-white/5 text-[#475569] cursor-not-allowed">
              Rewards unlock at Mainnet launch
            </button>
          ) : (
            <button
              onClick={handleClaim}
              disabled={claimBusy || !canClaimOnChain}
              className="px-5 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] transition-transform active:scale-95 disabled:opacity-50"
            >
              {claimBusy ? 'Claiming…' : 'Claim Reward'}
            </button>
          )}
          {claimSuccess && <div className="text-emerald-400 text-xs font-mono">✓ Claim successful.</div>}
          {claimError && <div className="text-red-400 text-xs font-mono">{claimError}</div>}
        </div>
      )}

      {/* BUG REPORT SUBMISSION — the actual "what to report" mechanism, not just rules text. */}
      <div className="bg-black/20 border border-white/5 rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-white font-bold text-sm">🐛 Report a Bug</h3>
          <p className="text-[#64748b] text-xs mt-1">Signed with your wallet so the report is provably yours — no gas, just a signature.</p>
        </div>

        {!walletAddress ? (
          <EmptyState compact icon="🔌" description="Connect your wallet to submit a bug report." />
        ) : (
          <form onSubmit={handleSubmitReport} className="space-y-3">
            <input
              type="text"
              required
              placeholder={'Short title, e.g. "Upload stalls at 90% on Sovereign Vault"'}
              value={reportForm.title}
              onChange={(e) => handleReportFieldChange('title', e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#475569] focus:outline-none focus:border-[#00f2fe]/40"
            />

            <div className="grid sm:grid-cols-2 gap-3">
              <select
                value={reportForm.layer}
                onChange={(e) => handleReportFieldChange('layer', e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#00f2fe]/40"
              >
                {IN_SCOPE_LAYERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <select
                value={reportForm.severity}
                onChange={(e) => handleReportFieldChange('severity', e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#00f2fe]/40"
              >
                {SEVERITY_LEVELS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>

            <textarea
              required
              placeholder="What happened? What did you expect instead?"
              value={reportForm.description}
              onChange={(e) => handleReportFieldChange('description', e.target.value)}
              rows={3}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#475569] focus:outline-none focus:border-[#00f2fe]/40 resize-none"
            />

            <textarea
              placeholder="Steps to reproduce (optional, but stronger reports score higher)"
              value={reportForm.stepsToReproduce}
              onChange={(e) => handleReportFieldChange('stepsToReproduce', e.target.value)}
              rows={2}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#475569] focus:outline-none focus:border-[#00f2fe]/40 resize-none"
            />

            <input
              type="text"
              placeholder="Evidence link — screenshot, video, log (optional)"
              value={reportForm.evidenceUrl}
              onChange={(e) => handleReportFieldChange('evidenceUrl', e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#475569] focus:outline-none focus:border-[#00f2fe]/40"
            />

            <button
              type="submit"
              disabled={reportBusy}
              className="px-5 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] transition-transform active:scale-95 disabled:opacity-50"
            >
              {reportBusy ? 'Signing & Submitting…' : 'Sign & Submit Report'}
            </button>

            {reportSuccessId && (
              <div className="text-emerald-400 text-xs font-mono">✓ Report submitted — reference id {reportSuccessId}.</div>
            )}
            {reportError && <div className="text-red-400 text-xs font-mono">{reportError}</div>}
          </form>
        )}
      </div>

      {walletAddress && myReports.length > 0 && (
        <div className="bg-black/20 border border-white/5 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 text-white font-bold text-sm">My Reports</div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-white/5 text-[#64748b]">
                <th className="text-left px-4 py-2 font-semibold">Title</th>
                <th className="text-left px-4 py-2 font-semibold">Layer</th>
                <th className="text-left px-4 py-2 font-semibold">Severity</th>
                <th className="text-right px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {myReports.map((r) => {
                const layer = IN_SCOPE_LAYERS.find((l) => l.id === r.layer);
                const severity = SEVERITY_LEVELS.find((s) => s.id === r.severity);
                const statusInfo = REPORT_STATUS_LABELS[r.status] || REPORT_STATUS_LABELS.submitted;
                return (
                  <tr key={r.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2 text-white">{r.title}</td>
                    <td className="px-4 py-2 text-[#94a3b8]">{layer ? layer.label : r.layer}</td>
                    <td className="px-4 py-2 text-[#94a3b8]">{severity ? severity.label : r.severity}</td>
                    <td className={`px-4 py-2 text-right ${statusInfo.color}`}>{statusInfo.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {walletAddress && !myReportsLoading && myReports.length === 0 && (
        <EmptyState compact icon="🐛" description="You haven't submitted any bug reports yet — the form above is where you report what you find." />
      )}
    </div>
  );
}
