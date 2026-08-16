// app/api/admin/dashboard/route.js
//
// GET /api/admin/dashboard?key=SECRET
//
// Private, owner-only read endpoint — NOT part of the public site. Gated
// by a single shared secret (process.env.ADMIN_DASHBOARD_SECRET) rather
// than a full login system, deliberately: this is a one-person dashboard,
// not a multi-admin surface, so the standing session/cookie machinery
// elsewhere in this codebase (orgs.js) would be overkill here.
//
// Two datasets, pulled straight from the existing referral and Watcher
// Pioneer collections — no new schema, no duplicated counters:
//   - referrers: email + successfulReferralCount
//   - watcher_pioneers + watcher_sessions: wallet + active-session flag +
//     points + INAYA equivalent

import { NextResponse } from "next/server";
import { getReferralCollections, ensureReferralIndexes } from "../../../../lib/referrals.js";
import { getWatcherCollections, ensureWatcherIndexes, WATCHER_POINTS_PER_INAYA } from "../../../../lib/watcherPioneer.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");
    if (!process.env.ADMIN_DASHBOARD_SECRET || key !== process.env.ADMIN_DASHBOARD_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await Promise.all([ensureReferralIndexes(), ensureWatcherIndexes()]);
    const { referrers } = await getReferralCollections();
    const { pioneers, sessions } = await getWatcherCollections();

    const [referrerRows, pioneerRows, activeSessionRows] = await Promise.all([
      referrers
        .find({}, { projection: { email: 1, successfulReferralCount: 1, status: 1 } })
        .sort({ successfulReferralCount: -1 })
        .toArray(),
      pioneers
        .find({}, { projection: { walletAddress: 1, totalPoints: 1 } })
        .sort({ totalPoints: -1 })
        .toArray(),
      sessions.find({ status: "active" }, { projection: { walletAddress: 1 } }).toArray(),
    ]);

    const activeWallets = new Set(activeSessionRows.map((s) => s.walletAddress));

    return NextResponse.json({
      referrers: referrerRows.map((r) => ({
        email: r.email,
        referrals: r.successfulReferralCount || 0,
        status: r.status,
      })),
      watchers: pioneerRows.map((p) => ({
        walletAddress: p.walletAddress,
        active: activeWallets.has(p.walletAddress),
        points: p.totalPoints || 0,
        inaya: (p.totalPoints || 0) / WATCHER_POINTS_PER_INAYA,
      })),
    });
  } catch (err) {
    console.error("admin/dashboard failed:", err);
    return NextResponse.json({ error: "Could not load dashboard data." }, { status: 500 });
  }
}
