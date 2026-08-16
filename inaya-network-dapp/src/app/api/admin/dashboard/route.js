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
// Four datasets:
//   - referrers: email + successfulReferralCount
//   - watcher_pioneers + watcher_sessions: wallet + active-session flag +
//     points + INAYA equivalent
//   - orgs + org_subscriptions + org_members: which package (plan) each
//     Business Workspace signup is on, plus live Stripe subscription
//     status where one exists (self-serve checkout) — orgs with no plan
//     yet, or assigned a plan without a Stripe subscription (Enterprise,
//     manually granted), simply have no subscriptionStatus.
//   - mobileDownloads: total .apk download count, pulled live from
//     GitHub's own Releases API (see getMobileApkDownloads below) rather
//     than a DB counter — GitHub already tracks this for us.
// First three are pulled straight from existing collections — no new
// schema, no duplicated counters.

import { NextResponse } from "next/server";
import { getReferralCollections, ensureReferralIndexes } from "../../../../lib/referrals.js";
import { getWatcherCollections, ensureWatcherIndexes, WATCHER_POINTS_PER_INAYA } from "../../../../lib/watcherPioneer.js";
import { getOrgCollections, ensureOrgIndexes } from "../../../../lib/orgs.js";
import { PLANS } from "../../../../lib/orgPlans.js";

export const dynamic = "force-dynamic";

const MOBILE_APK_REPO = "Talhawaqas/inaya-mobile";

// The dapp's download button links straight to a GitHub Releases asset —
// GitHub already counts every download of that file server-side, so
// there's no need for our own hit-counter. Summed across all releases
// (not just the current one) so the number stays correct as new alpha
// builds get published without a code change here.
async function getMobileApkDownloads() {
  try {
    const res = await fetch(`https://api.github.com/repos/${MOBILE_APK_REPO}/releases`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const releases = await res.json();
    if (!Array.isArray(releases)) return null;

    let total = 0;
    let latestVersion = null;
    for (const release of releases) {
      for (const asset of release.assets || []) {
        if (!asset.name?.toLowerCase().endsWith(".apk")) continue;
        total += asset.download_count || 0;
        if (!latestVersion) latestVersion = release.tag_name;
      }
    }
    return { total, latestVersion };
  } catch (err) {
    console.error("admin/dashboard: GitHub APK download count fetch failed:", err);
    return null;
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");
    if (!process.env.ADMIN_DASHBOARD_SECRET || key !== process.env.ADMIN_DASHBOARD_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await Promise.all([ensureReferralIndexes(), ensureWatcherIndexes(), ensureOrgIndexes()]);
    const { referrers } = await getReferralCollections();
    const { pioneers, sessions } = await getWatcherCollections();
    const { orgs, orgMembers, db } = await getOrgCollections();
    const orgSubscriptions = db.collection("org_subscriptions");

    const [referrerRows, pioneerRows, activeSessionRows, orgRows, memberCountRows, subscriptionRows, mobileDownloads] = await Promise.all([
      referrers
        .find({}, { projection: { email: 1, successfulReferralCount: 1, status: 1 } })
        .sort({ successfulReferralCount: -1 })
        .toArray(),
      pioneers
        .find({}, { projection: { walletAddress: 1, totalPoints: 1 } })
        .sort({ totalPoints: -1 })
        .toArray(),
      sessions.find({ status: "active" }, { projection: { walletAddress: 1 } }).toArray(),
      orgs
        .find({}, { projection: { name: 1, ownerEmail: 1, plan: 1, planUpdatedAt: 1, requiresPlanSelection: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .toArray(),
      orgMembers.aggregate([{ $match: { status: "active" } }, { $group: { _id: "$orgId", count: { $sum: 1 } } }]).toArray(),
      orgSubscriptions.find({}, { projection: { orgId: 1, status: 1, billingInterval: 1 } }).toArray(),
      getMobileApkDownloads(),
    ]);

    const activeWallets = new Set(activeSessionRows.map((s) => s.walletAddress));
    const memberCountByOrg = new Map(memberCountRows.map((m) => [m._id.toString(), m.count]));
    const subscriptionByOrg = new Map(subscriptionRows.map((s) => [s.orgId.toString(), s]));

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
      businesses: orgRows.map((o) => {
        const idStr = o._id.toString();
        const sub = subscriptionByOrg.get(idStr);
        return {
          orgId: idStr,
          name: o.name,
          ownerEmail: o.ownerEmail,
          plan: o.plan || null,
          planName: o.plan ? PLANS[o.plan]?.name || o.plan : o.requiresPlanSelection ? "No Plan Selected" : "Legacy (Unrestricted)",
          subscriptionStatus: sub?.status || null,
          billingInterval: sub?.billingInterval || null,
          memberCount: memberCountByOrg.get(idStr) || 0,
          createdAt: o.createdAt,
        };
      }),
      mobileDownloads,
    });
  } catch (err) {
    console.error("admin/dashboard failed:", err);
    return NextResponse.json({ error: "Could not load dashboard data." }, { status: 500 });
  }
}
