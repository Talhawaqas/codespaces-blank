// app/api/cron/business-ops/route.js
//
// GET /api/cron/business-ops — daily, same CRON_SECRET bearer-token check as
// every other cron route. Runs four independent jobs; one failing never
// stops the others, and each reports its own result:
//   taskReminders  "due tomorrow" / "overdue" notices (lib/business-notify.js)
//   autoReorder    draft purchase requests for opted-in low-stock products
//                  (lib/inventory-reorder.js)
//   fxRates        store today's exchange-rate snapshot (lib/fx-rates.js)
//   ledger         post any missing automatic journal entries (lib/ledger.js)
//   commerceStock  Inaya Commerce companies: stock levels and reservations checked against the stock ledger and open
//                  orders; differences are reported (never auto-repaired -- a manager repairs from Point of Sale)
//   growth         Inaya Commerce companies: loyalty points expiry, membership housekeeping, triggered marketing
//                  (consent, suppression, frequency caps and quiet hours enforced in src/lib/growth/triggers.js)

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runTaskReminders } from "../../../../lib/business-notify.js";
import { runAutoReorder } from "../../../../lib/inventory-reorder.js";
import { syncAllLedgers } from "../../../../lib/ledger.js";
import { refreshFxRates } from "../../../../lib/fx-rates.js";

async function runJob(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    console.error("cron/business-ops job failed:", err);
    return { ok: false, error: err.message };
  }
}

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const taskReminders = await runJob(() => runTaskReminders());
  const autoReorder = await runJob(() => runAutoReorder());
  // Rates first, so today's ledger postings can use them. A failed fetch is reported, never fatal.
  const fxRates = await runJob(async () => { const r = await refreshFxRates(); if (!r.stored) throw new Error(r.error); return r; });
  const ledger = await runJob(() => syncAllLedgers());
  const commerceStock = await runJob(async () => {
    const { getOrgCollections } = await import("../../../../lib/orgs.js");
    const { reconcileStockLevels } = await import("../../../../lib/inventory.js");
    const { orgs } = await getOrgCollections();
    const list = await orgs.find({ "features.FEATURE_COMMERCE": true }, { projection: { _id: 1 } }).toArray();
    let withIssues = 0, mismatches = 0, reservationIssues = 0;
    for (const o of list) {
      try {
        const r = await reconcileStockLevels({ orgId: o._id });
        if (r.mismatches.length || r.reservationIssues.length) { withIssues++; mismatches += r.mismatches.length; reservationIssues += r.reservationIssues.length; console.warn(`commerce stock check: org ${o._id} has ${r.mismatches.length} level and ${r.reservationIssues.length} reservation difference(s)`); }
      } catch (e) { console.error(`commerce stock check failed for org ${o._id}:`, e.message); }
    }
    return { companies: list.length, withIssues, mismatches, reservationIssues };
  });
  const growth = await runJob(async () => {
    const { getOrgCollections } = await import("../../../../lib/orgs.js");
    const L = await import("../../../../lib/growth/loyalty.js"); const T = await import("../../../../lib/growth/triggers.js");
    const { orgs } = await getOrgCollections();
    const list = await orgs.find({ "features.FEATURE_COMMERCE": true }, { projection: { _id: 1 } }).toArray();
    let expired = 0, memberships = 0, enrolled = 0, failed = 0;
    for (const o of list) {
      try { expired += (await L.expirePoints({ orgId: o._id })).expiredPoints; memberships += (await L.membershipHousekeeping({ orgId: o._id })).expired; const t = await T.runTriggers({ orgId: o._id }); enrolled += t.triggers.reduce((n, x) => n + (x.enrolled || 0), 0); }
      catch (e) { failed++; console.error(`growth jobs failed for org ${o._id}:`, e.message); }
    }
    return { companies: list.length, expiredPoints: expired, expiredMemberships: memberships, enrolled, failed };
  });
  return NextResponse.json({ success: taskReminders.ok && autoReorder.ok && fxRates.ok && ledger.ok && commerceStock.ok && growth.ok, taskReminders, autoReorder, fxRates, ledger, commerceStock, growth });
}
