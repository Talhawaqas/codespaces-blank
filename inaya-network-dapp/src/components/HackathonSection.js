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

const HACKATHON_REWARDS_ADDRESS = process.env.NEXT_PUBLIC_HACKATHON_REWARDS_ADDRESS || '';

const HACKATHON_REWARDS_ABI = [
  'function allocations(address) view returns (uint256)',
  'function claimed(address) view returns (bool)',
  'function mainnetActive() view returns (bool)',
  'function claim() external',
];

function truncateAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function HackathonSection({ walletAddress, getActiveProvider }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [onChain, setOnChain] = useState(null); // { allocation, claimed, mainnetActive } once contract address exists
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [claimSuccess, setClaimSuccess] = useState(false);

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
    </div>
  );
}
