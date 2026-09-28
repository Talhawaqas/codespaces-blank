// app/api/moderator/dashboard/route.js
//
// GET /api/moderator/dashboard
//
// Deliberately narrow: Watcher Pioneer Program wallets + KYC'd individuals
// (referral program), nothing else — no revenue, no business/org data, no
// fraud internals, no node operators. That's the whole point of a separate
// moderator credential (see moderator-auth.js) instead of just handing out
// the admin passphrase to more people.
//
// Two datasets:
//   - watchers: every enrolled Watcher Pioneer wallet, points, active-session
//     flag — same shape admin/dashboard already exposes for this program.
//   - kycIndividuals: every person who has gone through Didit KYC in the
//     referral program, either as a referrer (one-time "activation" KYC) or
//     as a referred person (per-referral KYC) — unified so a moderator can
//     watch both in one place, each row labeled with its role and real
//     status (verified/pending/rejected), not masked, since a moderator
//     needs to actually identify and act on a specific person's record.

import { NextResponse } from "next/server";
import { isModeratorAuthenticated } from "../../../../lib/moderator-auth.js";
import { getWatcherCollections, ensureWatcherIndexes, WATCHER_POINTS_PER_INAYA } from "../../../../lib/watcherPioneer.js";
import { getReferralCollections, ensureReferralIndexes } from "../../../../lib/referrals.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isModeratorAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await Promise.all([ensureWatcherIndexes(), ensureReferralIndexes()]);
    const { pioneers, sessions } = await getWatcherCollections();
    const { referrers, referrals } = await getReferralCollections();

    const [pioneerRows, activeSessionRows, referrerRows, referralRows] = await Promise.all([
      pioneers.find({}, { projection: { walletAddress: 1, totalPoints: 1, enrolledAt: 1 } }).sort({ totalPoints: -1 }).toArray(),
      sessions.find({ status: "active" }, { projection: { walletAddress: 1 } }).toArray(),
      referrers.find({}, { projection: { email: 1, status: 1, rejectionReason: 1, verifiedAt: 1, createdAt: 1, successfulReferralCount: 1 } }).sort({ createdAt: -1 }).toArray(),
      referrals.find({}, { projection: { referrerEmail: 1, referredEmail: 1, status: 1, rejectionReason: 1, creditedAt: 1, createdAt: 1 } }).sort({ createdAt: -1 }).toArray(),
    ]);

    const activeWallets = new Set(activeSessionRows.map((s) => s.walletAddress));

    const kycIndividuals = [
      ...referrerRows.map((r) => ({
        email: r.email,
        role: "referrer",
        status: r.status,
        rejectionReason: r.rejectionReason || null,
        verifiedAt: r.verifiedAt || null,
        createdAt: r.createdAt,
        successfulReferralCount: r.successfulReferralCount || 0,
      })),
      ...referralRows.map((r) => ({
        email: r.referredEmail,
        role: "referred",
        status: r.status,
        rejectionReason: r.rejectionReason || null,
        verifiedAt: r.creditedAt || null,
        createdAt: r.createdAt,
        referredBy: r.referrerEmail,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return NextResponse.json({
      watchers: pioneerRows.map((p) => ({
        walletAddress: p.walletAddress,
        active: activeWallets.has(p.walletAddress),
        points: p.totalPoints || 0,
        inaya: (p.totalPoints || 0) / WATCHER_POINTS_PER_INAYA,
        enrolledAt: p.enrolledAt,
      })),
      kycIndividuals,
    });
  } catch (err) {
    console.error("moderator/dashboard failed:", err);
    return NextResponse.json({ error: "Could not load moderator dashboard data." }, { status: 500 });
  }
}
