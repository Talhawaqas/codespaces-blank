// src/components/ReferralSection.js
//
// "Referrals" tab — email + Didit KYC only, no wallet-connect anywhere in
// this component (non-negotiable per the SOW). Kept as its own
// self-contained component rather than folded into page.js's existing
// state blob: it has no dependency on wallet/contract state, so isolating
// it keeps the 5800+ line page.js diff small and this feature independently
// testable.
//
// Flow:
//   1. Enter your own email -> POST /api/referrals/activate -> Didit KYC
//      (referrers verify their own identity once; see src/lib/referrals.js
//      on the backend for why this is required for real self-referral
//      detection, not just an extra hoop).
//   2. Once verified, you get a referralCode and can enter a referred
//      person's email -> POST /api/referrals/initiate -> a Didit KYC link
//      for THEM.
//   3. That link is also emailed automatically via lib/email.js (Resend) —
//      best-effort, never blocks the referral itself. Still shown with a
//      copy button too, both because it's a good fallback if RESEND_API_KEY
//      isn't configured (sendEmail() no-ops rather than failing) and because
//      the referrer may just want to send it themselves anyway.
//   4. Own history + running INAYA total, plus the global Top-50
//      leaderboard (ranked strictly by successful-referral count).

'use client';

import { useState, useEffect, useCallback } from 'react';

// Persisted purely so a returning referrer's verified code/status survives
// navigating away and back (this component fully unmounts whenever
// page.js's currentPage leaves 'Referrals' — see its render branch) or a
// page reload — without this, `activatedEmail`/`referrerStatus` reset to
// nothing and the verified branch below can never render again until the
// user re-types their email and resubmits, even though they're already
// verified. Just an email address, not sensitive.
const ACTIVATED_EMAIL_KEY = 'inaya_referral_activated_email';

// Same reasoning as ACTIVATED_EMAIL_KEY, for the OTHER side of the flow: a
// referred person who redeems a code, closes the tab before finishing
// Didit's Liveness step, and comes back later has no way to get their
// verification link back short of re-typing the exact code + email they
// used originally. Persisting {referralId, redeemEmail} lets this page
// resume polling and re-show the still-valid link automatically instead.
const REDEEM_PENDING_KEY = 'inaya_referral_redeem_pending';

function StatusPill({ status }) {
  const map = {
    verified: ['bg-emerald-400/10 text-emerald-400 border-emerald-400/30', '✅ Verified'],
    pending: ['bg-amber-400/10 text-amber-400 border-amber-400/30', '⏳ Pending KYC'],
    rejected: ['bg-red-400/10 text-red-400 border-red-400/30', '❌ Rejected'],
    not_started: ['bg-white/5 text-[#8a96ab] border-white/10', 'Not started'],
  };
  const [cls, label] = map[status] || map.not_started;
  return <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border ${cls}`}>{label}</span>;
}

export default function ReferralSection() {
  const [email, setEmail] = useState('');
  const [activatedEmail, setActivatedEmail] = useState(''); // the email we've actually activated/polled for
  const [referrerStatus, setReferrerStatus] = useState(null); // { status, referralCode, successfulReferralCount, rejectionReason }
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState('');
  const [kycUrl, setKycUrl] = useState('');

  const [referredEmail, setReferredEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteEmailSent, setInviteEmailSent] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const [history, setHistory] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(true);

  const [shareLinkCopied, setShareLinkCopied] = useState(false);

  // Redeem-by-link: someone arrived via ?ref=CODE from a referrer's shared link.
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemEmail, setRedeemEmail] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState('');
  const [redeemUrl, setRedeemUrl] = useState('');
  const [redeemReferralId, setRedeemReferralId] = useState('');
  const [redeemAwaitingStep, setRedeemAwaitingStep] = useState(null);
  const [redeemResolvedStatus, setRedeemResolvedStatus] = useState(null); // 'verified' | 'rejected' | null (still pending)
  const [redeemRejectionReason, setRedeemRejectionReason] = useState(null);
  const [showResumeForm, setShowResumeForm] = useState(false);

  const refreshStatus = useCallback(async (targetEmail) => {
    if (!targetEmail) return;
    try {
      const res = await fetch(`/api/referrals/status?email=${encodeURIComponent(targetEmail)}`);
      const data = await res.json();
      if (res.ok) {
        setReferrerStatus(data);
        // Lets a returning user (fresh page load, or after an app restart) resume
        // an already-created session's link without re-POSTing /activate — that
        // route would otherwise mint a wasteful duplicate Didit session just to
        // show them the same link again.
        if (data.url) setKycUrl(data.url);
      }
    } catch {
      // Silent — this is a background poll, the activate/initiate error states
      // already surface anything the user needs to act on.
    }
  }, []);

  const refreshRedeemStatus = useCallback(async (referralId) => {
    if (!referralId) return;
    try {
      const res = await fetch(`/api/referrals/status?referralId=${encodeURIComponent(referralId)}`);
      const data = await res.json();
      if (!res.ok) return;
      if (data.status === 'pending') {
        if (data.url) setRedeemUrl(data.url);
        setRedeemAwaitingStep(data.awaitingStep || null);
      } else {
        // Resolved (verified/rejected) — nothing left to resume, stop persisting it.
        setRedeemResolvedStatus(data.status);
        setRedeemRejectionReason(data.rejectionReason || null);
        window.localStorage.removeItem(REDEEM_PENDING_KEY);
      }
    } catch {
      // Silent — background poll, same as refreshStatus above.
    }
  }, []);

  const refreshHistory = useCallback(async (targetEmail) => {
    if (!targetEmail) return;
    try {
      const res = await fetch(`/api/referrals/history?email=${encodeURIComponent(targetEmail)}`);
      const data = await res.json();
      if (res.ok) setHistory(data);
    } catch {
      // Same as above — non-critical background refresh.
    }
  }, []);

  useEffect(() => {
    fetch('/api/referrals/leaderboard')
      .then((res) => res.json())
      .then((data) => setLeaderboard(data.leaderboard || []))
      .catch(() => {})
      .finally(() => setLoadingLeaderboard(false));
  }, []);

  // Pick up ?ref=CODE from a shared link on first load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) setRedeemCode(ref.trim().toUpperCase());
  }, []);

  // Resume a previously-activated referrer on mount — see ACTIVATED_EMAIL_KEY's
  // comment. refreshStatus() also benefits from /api/referrals/status's own
  // Didit-reconciliation fallback, so this doubles as a chance to self-heal
  // a status that's stuck on "pending" locally despite already being
  // verified on Didit's side.
  useEffect(() => {
    const persisted = window.localStorage.getItem(ACTIVATED_EMAIL_KEY);
    if (!persisted) return;
    setEmail(persisted);
    setActivatedEmail(persisted);
    refreshStatus(persisted);
  }, [refreshStatus]);

  // Same resume behavior for a referred person who redeemed a code and left
  // before finishing — see REDEEM_PENDING_KEY's comment.
  useEffect(() => {
    let persisted;
    try {
      persisted = JSON.parse(window.localStorage.getItem(REDEEM_PENDING_KEY) || 'null');
    } catch {
      persisted = null;
    }
    if (!persisted?.referralId) return;
    setRedeemReferralId(persisted.referralId);
    if (persisted.redeemEmail) setRedeemEmail(persisted.redeemEmail);
    refreshRedeemStatus(persisted.referralId);
  }, [refreshRedeemStatus]);

  // Poll while a KYC decision is still pending — the webhook updates the
  // backend asynchronously, this is how the UI notices without a page reload.
  useEffect(() => {
    if (!activatedEmail || referrerStatus?.status !== 'pending') return;
    const id = setInterval(() => refreshStatus(activatedEmail), 5000);
    return () => clearInterval(id);
  }, [activatedEmail, referrerStatus?.status, refreshStatus]);

  useEffect(() => {
    if (!redeemReferralId || redeemResolvedStatus) return;
    const id = setInterval(() => refreshRedeemStatus(redeemReferralId), 5000);
    return () => clearInterval(id);
  }, [redeemReferralId, redeemResolvedStatus, refreshRedeemStatus]);

  useEffect(() => {
    if (referrerStatus?.status === 'verified' && activatedEmail) refreshHistory(activatedEmail);
  }, [referrerStatus?.status, activatedEmail, refreshHistory]);

  async function handleActivate(e) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setActivating(true);
    setActivationError('');
    setKycUrl('');
    try {
      const res = await fetch('/api/referrals/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start verification.');
      setActivatedEmail(trimmed);
      window.localStorage.setItem(ACTIVATED_EMAIL_KEY, trimmed);
      setReferrerStatus(data.status === 'verified' ? { status: 'verified', referralCode: data.referralCode } : { status: 'pending' });
      if (data.url) setKycUrl(data.url);
    } catch (err) {
      setActivationError(err.message);
    } finally {
      setActivating(false);
    }
  }

  async function handleInvite(e) {
    e.preventDefault();
    const trimmed = referredEmail.trim().toLowerCase();
    if (!trimmed) return;
    setInviting(true);
    setInviteError('');
    setInviteUrl('');
    setInviteEmailSent(false);
    setInviteCopied(false);
    try {
      const res = await fetch('/api/referrals/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referrerEmail: activatedEmail, referredEmail: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the referral.');
      if (data.url) setInviteUrl(data.url);
      setInviteEmailSent(!!data.emailSent);
      setReferredEmail('');
      refreshHistory(activatedEmail);
    } catch (err) {
      setInviteError(err.message);
    } finally {
      setInviting(false);
    }
  }

  function copyInviteUrl() {
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    });
  }

  function copyShareLink() {
    const link = `${window.location.origin}${window.location.pathname}?ref=${referrerStatus.referralCode}`;
    navigator.clipboard.writeText(link).then(() => {
      setShareLinkCopied(true);
      setTimeout(() => setShareLinkCopied(false), 2000);
    });
  }

  async function handleRedeem(e) {
    e.preventDefault();
    const trimmedEmail = redeemEmail.trim().toLowerCase();
    const trimmedCode = redeemCode.trim().toUpperCase();
    if (!trimmedEmail || !trimmedCode) return;
    setRedeeming(true);
    setRedeemError('');
    setRedeemUrl('');
    setRedeemResolvedStatus(null);
    setRedeemRejectionReason(null);
    try {
      const res = await fetch('/api/referrals/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: trimmedCode, referredEmail: trimmedEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start verification.');
      if (data.url) setRedeemUrl(data.url);
      if (data.referralId) {
        setRedeemReferralId(data.referralId);
        window.localStorage.setItem(REDEEM_PENDING_KEY, JSON.stringify({ referralId: data.referralId, redeemEmail: trimmedEmail }));
      }
    } catch (err) {
      setRedeemError(err.message);
    } finally {
      setRedeeming(false);
    }
  }

  const isVerifiedReferrer = referrerStatus?.status === 'verified';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-extrabold text-white tracking-tight">Referrals</h2>
        <p className="text-[#94a3b8] text-sm mt-1">
          Earn 0.4 INAYA for every successful referral, and the person you refer earns 0.1 INAYA — no wallet needed, just email and a quick identity check.
          Rewards are recorded now and distributed at mainnet.
        </p>
        {!redeemCode && !redeemUrl && !showResumeForm && (
          <button
            type="button"
            onClick={() => setShowResumeForm(true)}
            className="text-[#00f2fe] text-xs underline mt-2"
          >
            Already started a verification? Resume it
          </button>
        )}
      </div>

      {/* REDEEM A SHARED LINK: ?ref=CODE lands here, or "Resume it" above for
          someone who has their code/email but lost the link. */}
      {(redeemCode || showResumeForm) && !redeemUrl && (
        <div className="bg-[#090d16]/80 border border-[#00f2fe]/30 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-1">
            {redeemCode ? <>You were invited with code <span className="text-[#00f2fe]">{redeemCode}</span></> : 'Resume your verification'}
          </h3>
          <p className="text-[#8a96ab] text-xs mb-4">Enter your email{redeemCode ? '' : ' and referral code'} to start — or pick back up where you left off if you already started.</p>
          <form onSubmit={handleRedeem} className="flex flex-col sm:flex-row gap-3">
            {!redeemCode && (
              <input
                type="text"
                required
                value={redeemCode}
                onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
                placeholder="REFERRAL CODE"
                className="sm:w-40 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
              />
            )}
            <input
              type="email"
              required
              value={redeemEmail}
              onChange={(e) => setRedeemEmail(e.target.value)}
              placeholder="you@example.com"
              className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
            />
            <button
              type="submit"
              disabled={redeeming}
              className="px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40"
            >
              {redeeming ? 'Starting…' : 'Start verification'}
            </button>
          </form>
          {redeemError && <p className="text-red-400 text-xs mt-3">{redeemError}</p>}
        </div>
      )}
      {redeemUrl && redeemResolvedStatus !== 'verified' && (
        <div className="bg-[#090d16]/80 border border-amber-400/20 rounded-2xl p-6">
          {redeemAwaitingStep === 'liveness' ? (
            <p className="text-emerald-400 text-xs font-bold mb-2">✅ ID approved — just one more step: complete the quick selfie/liveness check to finish.</p>
          ) : (
            <p className="text-amber-400 text-xs font-bold mb-2">Complete your verification here:</p>
          )}
          <a href={redeemUrl} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline text-xs break-all">{redeemUrl}</a>
          <p className="text-[#8a96ab] text-xs mt-2">This page checks automatically every few seconds — you can safely close this tab and come back later, this link stays valid.</p>
        </div>
      )}
      {redeemResolvedStatus === 'verified' && (
        <div className="bg-emerald-400/10 border border-emerald-400/30 rounded-2xl p-6">
          <p className="text-emerald-400 text-sm font-bold">🎉 Verified! Your referral reward has been recorded.</p>
        </div>
      )}
      {redeemResolvedStatus === 'rejected' && (
        <div className="bg-red-400/10 border border-red-400/30 rounded-2xl p-6">
          <p className="text-red-400 text-sm font-bold">Verification wasn't approved{redeemRejectionReason ? ` (${redeemRejectionReason})` : ''}.</p>
        </div>
      )}

      {/* STEP 1: ACTIVATE AS A REFERRER */}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white">1. Verify your own identity</h3>
          {referrerStatus && <StatusPill status={referrerStatus.status} />}
        </div>
        <p className="text-[#8a96ab] text-xs mb-4">
          A one-time identity check (ID + liveness, via Didit) is required before you can refer anyone — this is what lets us actually
          detect and block self-referral, instead of just trusting an email address.
        </p>

        {!isVerifiedReferrer && (
          <form onSubmit={handleActivate} className="flex flex-col sm:flex-row gap-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
            />
            <button
              type="submit"
              disabled={activating}
              className="px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40"
            >
              {activating ? 'Starting…' : 'Start verification'}
            </button>
          </form>
        )}

        {activationError && <p className="text-red-400 text-xs mt-3">{activationError}</p>}

        {kycUrl && referrerStatus?.status === 'pending' && (
          <div className="mt-4 bg-black/20 border border-amber-400/20 rounded-xl p-4">
            {referrerStatus?.awaitingStep === 'liveness' ? (
              <p className="text-emerald-400 text-xs font-bold mb-2">✅ ID approved — just one more step: complete the quick selfie/liveness check to finish.</p>
            ) : (
              <p className="text-amber-400 text-xs font-bold mb-2">Complete your verification to activate:</p>
            )}
            <a href={kycUrl} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline text-xs break-all">{kycUrl}</a>
          </div>
        )}

        {referrerStatus?.status === 'pending' && !kycUrl && (
          <p className="text-amber-400 text-xs mt-3">Verification in progress — this page checks automatically every few seconds.</p>
        )}

        {referrerStatus?.status === 'rejected' && (
          <p className="text-red-400 text-xs mt-3">
            Verification wasn't approved{referrerStatus.rejectionReason ? ` (${referrerStatus.rejectionReason.replace(/_/g, ' ')})` : ''}. You can try again above.
          </p>
        )}

        {isVerifiedReferrer && (
          <div className="mt-2 space-y-3">
            <div className="font-mono text-xs text-slate-300">
              Your referral code: <span className="text-[#00f2fe] font-bold">{referrerStatus.referralCode}</span>
            </div>
            <div className="bg-black/20 border border-white/10 rounded-xl p-4">
              <p className="text-slate-400 text-xs mb-2">Your shareable link — anyone who signs up through it and completes KYC earns you 0.4 INAYA:</p>
              <div className="flex items-center gap-2">
                <span className="text-[#00f2fe] text-xs break-all font-mono">
                  {typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}?ref=${referrerStatus.referralCode}` : ''}
                </span>
                <button onClick={copyShareLink} type="button" className="shrink-0 text-[10px] font-bold uppercase bg-white/5 border border-white/10 px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10">
                  {shareLinkCopied ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* STEP 2: INVITE SOMEONE DIRECTLY BY EMAIL */}
      {isVerifiedReferrer && (
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-3">2. Or invite someone directly by email</h3>
          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
            <input
              type="email"
              required
              value={referredEmail}
              onChange={(e) => setReferredEmail(e.target.value)}
              placeholder="their-email@example.com"
              className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/50"
            />
            <button
              type="submit"
              disabled={inviting}
              className="px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40"
            >
              {inviting ? 'Sending…' : 'Send invite'}
            </button>
          </form>
          {inviteError && <p className="text-red-400 text-xs mt-3">{inviteError}</p>}
          {inviteUrl && (
            <div className="mt-4 bg-black/20 border border-white/10 rounded-xl p-4">
              <p className="text-slate-400 text-xs mb-2">
                {inviteEmailSent
                  ? "✓ We've emailed them a verification link. You can also share it directly:"
                  : "Share this verification link with them — email delivery isn't configured yet, so it wasn't sent automatically:"}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-[#00f2fe] text-xs break-all font-mono">{inviteUrl}</span>
                <button onClick={copyInviteUrl} type="button" className="shrink-0 text-[10px] font-bold uppercase bg-white/5 border border-white/10 px-2.5 py-1.5 rounded-lg text-slate-300 hover:bg-white/10">
                  {inviteCopied ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 3: HISTORY */}
      {isVerifiedReferrer && history && (
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white mb-4">Your referrals</h3>
          <div className="grid grid-cols-2 gap-4 font-mono text-xs mb-5">
            <div className="bg-black/20 border-l-4 border-[#00f2fe] p-4 rounded-r-xl">
              <div className="text-xl font-bold text-white">{history.successfulReferralCount}</div>
              <div className="text-[10px] uppercase text-[#8a96ab] mt-1">Successful Referrals</div>
            </div>
            <div className="bg-black/20 border-l-4 border-emerald-400 p-4 rounded-r-xl">
              <div className="text-xl font-bold text-white">{history.totalInayaEarned.toFixed(2)} INAYA</div>
              <div className="text-[10px] uppercase text-[#8a96ab] mt-1">Total Earned</div>
            </div>
          </div>
          {history.referrals.length === 0 ? (
            <p className="text-[#8a96ab] text-xs italic">No referrals yet — invite someone above.</p>
          ) : (
            <table className="w-full text-left font-mono text-xs border-collapse">
              <thead>
                <tr className="border-b border-white/10 text-slate-400 text-[10px] uppercase">
                  <th className="p-2 font-bold">Email</th>
                  <th className="p-2 font-bold">Status</th>
                  <th className="p-2 font-bold">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-slate-300">
                {history.referrals.map((r, i) => (
                  <tr key={i}>
                    <td className="p-2 text-white">{r.referredEmail}</td>
                    <td className="p-2"><StatusPill status={r.status === 'verified' ? 'verified' : r.status === 'pending' ? 'pending' : 'rejected'} /></td>
                    <td className="p-2">{new Date(r.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* LEADERBOARD */}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
        <h3 className="text-sm font-bold text-white mb-4">🏆 Top 50 Referrers</h3>
        {loadingLeaderboard ? (
          <p className="text-[#8a96ab] text-xs">Loading…</p>
        ) : leaderboard.length === 0 ? (
          <p className="text-[#8a96ab] text-xs italic">No successful referrals yet — be the first.</p>
        ) : (
          <table className="w-full text-left font-mono text-xs border-collapse">
            <thead>
              <tr className="border-b border-white/10 text-slate-400 text-[10px] uppercase">
                <th className="p-2 font-bold">Rank</th>
                <th className="p-2 font-bold">Referrer</th>
                <th className="p-2 font-bold">Successful Referrals</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-slate-300">
              {leaderboard.map((row) => (
                <tr key={row.rank}>
                  <td className="p-2 text-white font-bold">#{row.rank}</td>
                  <td className="p-2">{row.email}</td>
                  <td className="p-2 text-[#00f2fe] font-bold">{row.successfulReferralCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
