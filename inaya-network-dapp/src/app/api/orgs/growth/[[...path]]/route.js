// app/api/orgs/growth/[[...path]]/route.js -- Inaya Commerce Phase 4: Customer 360, loyalty, gift cards, promotions,
// automation and the growth assistant (Master SOW section 8). Session + membership first (License Manager gate included);
// role and entitlement checks live in src/lib/growth/* (loyalty, cards, promotions and automation are part of the
// Commerce add-on; the customer profile, timeline and duplicates follow CRM / owner-admin permissions).
//
//   GET  customers/{id}/timeline   GET customers/{id}/intelligence   GET customers/{id}/loyalty   GET customers/{id}/cards
//   PUT  customers/{id}/profile { customerType, contactPreferences, accountStatus, accountManagerEmail, creditLimit, birthday, tags, sourceChannel }
//   GET  duplicates   POST duplicates/preview { survivorId, duplicateId }   POST duplicates/merge { survivorId, duplicateId, reason }   GET merges   POST merges/{id}/undo
//   GET  loyalty/settings  PUT loyalty/settings   GET loyalty/liability   POST loyalty/adjust { customerId, points, reason }
//   GET  plans  POST plans { id?, name, fee, durationMonths, discountPercent, pointsMultiplier, branchIds, cancellationPolicy }
//   POST memberships { customerId, planId, payment }   POST memberships/cancel { customerId, reason, refund? }
//   POST cards/balance { code }   POST cards/replace { code|cardId, reason }   GET cards/liability   POST cards/breakage { cardId, reason }   POST cards/breakage/{id}/decide { approve }
//   GET  promotions   POST promotions { id?, ...rules }   POST promotions/{id}/{approve|pause|resume|end}
//   GET  automation/settings  PUT automation/settings   GET triggers   POST triggers { id?, type, sequenceId, days?, productIds?, categories?, active }
//   POST triggers/run { dryRun }   GET attribution (?days)
//   GET  assistant/at-risk   GET assistant/next-products?customerId   GET assistant/patterns   GET assistant/summary?customerId
//   GET  assistant/segment?segmentId   GET assistant/campaign?campaignId   POST assistant/draft { goal, segmentId? }
//   GET  segments/{id}/export (CSV)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import * as C360 from "../../../../../lib/growth/customer360.js";
import * as LOY from "../../../../../lib/growth/loyalty.js";
import * as GC from "../../../../../lib/growth/giftcards.js";
import * as PROMO from "../../../../../lib/growth/promotions.js";
import * as TRG from "../../../../../lib/growth/triggers.js";
import * as AS from "../../../../../lib/growth/assistant.js";
import { exportSegment } from "../../../../../lib/growth/segments.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));
async function ctx(req, orgId) {
  if (!orgId) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { membership: auth.membership, actorEmail: auth.session.email };
}

export async function GET(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership };
    if (seg[0] === "customers" && seg[1]) {
      if (seg[2] === "timeline") return out(await C360.timeline({ ...b, customerId: seg[1] }));
      if (seg[2] === "intelligence") return out(await C360.intelligence({ ...b, customerId: seg[1] }));
      if (seg[2] === "loyalty") return out(await LOY.customerLoyalty({ ...b, customerId: seg[1] }));
      if (seg[2] === "cards") return json({ cards: await GC.customerCards({ orgId, customerId: seg[1] }) });
    }
    if (path === "duplicates") return out(await C360.findDuplicates(b));
    if (path === "merges") return out(await C360.listMerges(b));
    if (path === "loyalty/settings") return json({ settings: await LOY.getLoyaltySettings(orgId) });
    if (path === "loyalty/liability") return out(await LOY.loyaltyLiability(b));
    if (path === "plans") return json(await LOY.listPlans({ orgId }));
    if (path === "cards/liability") return out(await GC.cardLiability(b));
    if (path === "promotions") return out(await PROMO.listPromotions(b));
    if (path === "automation/settings") return json({ settings: await TRG.getAutomationSettings(orgId) });
    if (path === "triggers") return out(await TRG.listTriggers(b));
    if (path === "attribution") return out(await TRG.attribution({ ...b, days: Number(qs.get("days")) || 90 }));
    if (path === "assistant/at-risk") return out(await AS.atRiskCustomers(b));
    if (path === "assistant/next-products") return out(await AS.nextBestProducts({ ...b, customerId: qs.get("customerId") }));
    if (path === "assistant/patterns") return out(await AS.unusualPatterns(b));
    if (path === "assistant/summary") return out(await AS.relationshipSummary({ ...b, customerId: qs.get("customerId") }));
    if (path === "assistant/segment") return out(await AS.summarizeSegment({ ...b, segmentId: qs.get("segmentId") }));
    if (path === "assistant/campaign") return out(await AS.explainCampaign({ ...b, campaignId: qs.get("campaignId") }));
    if (seg[0] === "segments" && seg[1] && seg[2] === "export") { const r = await exportSegment({ ...b, actorEmail: c.actorEmail, segmentId: seg[1] }); if (r.error) return out(r); return new NextResponse(r.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.filename}"`, "Cache-Control": "no-store" } }); }
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error("orgs/growth GET failed:", path, err?.message); return json({ error: "Could not load." }, 500); }
}

async function write(req, params, method) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const orgId = body.orgId || new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (method === "PUT" && seg[0] === "customers" && seg[1] && seg[2] === "profile") return out(await C360.updateProfile({ ...b, customerId: seg[1], input: body }));
    if (method === "POST" && path === "duplicates/preview") return out(await C360.mergePreview({ ...b, survivorId: body.survivorId, duplicateId: body.duplicateId }));
    if (method === "POST" && path === "duplicates/merge") return out(await C360.mergeCustomers({ ...b, survivorId: body.survivorId, duplicateId: body.duplicateId, reason: body.reason }));
    if (method === "POST" && seg[0] === "merges" && seg[1] && seg[2] === "undo") return out(await C360.undoMerge({ ...b, mergeId: seg[1] }));
    if (method === "PUT" && path === "loyalty/settings") return out(await LOY.updateLoyaltySettings({ ...b, input: body }));
    if (method === "POST" && path === "loyalty/adjust") return out(await LOY.adjustPoints({ ...b, customerId: body.customerId, points: body.points, reason: body.reason }));
    if (method === "POST" && path === "plans") return out(await LOY.savePlan({ ...b, id: body.id, input: body }));
    if (method === "POST" && path === "memberships") return out(await LOY.joinPlan({ ...b, customerId: body.customerId, planId: body.planId, payment: body.payment }));
    if (method === "POST" && path === "memberships/cancel") return out(await LOY.cancelMembership({ ...b, customerId: body.customerId, reason: body.reason, refund: body.refund }));
    if (method === "POST" && path === "cards/balance") return out(await GC.cardBalance({ ...b, code: body.code }));
    if (method === "POST" && path === "cards/replace") return out(await GC.replaceCard({ ...b, code: body.code, cardId: body.cardId, reason: body.reason }));
    if (method === "POST" && path === "cards/breakage") return out(await GC.requestBreakage({ ...b, cardId: body.cardId, reason: body.reason }));
    if (method === "POST" && seg[0] === "cards" && seg[1] === "breakage" && seg[2] && seg[3] === "decide") return out(await GC.decideBreakage({ ...b, requestId: seg[2], approve: body.approve === true }));
    if (method === "POST" && path === "promotions") return out(await PROMO.savePromotion({ ...b, id: body.id, input: body }));
    if (method === "POST" && seg[0] === "promotions" && seg[1] && seg[2]) return out(await PROMO.transitionPromotion({ ...b, id: seg[1], action: seg[2] }));
    if (method === "PUT" && path === "automation/settings") return out(await TRG.updateAutomationSettings({ ...b, input: body }));
    if (method === "POST" && path === "triggers") return out(await TRG.saveTrigger({ ...b, id: body.id, input: body }));
    if (method === "POST" && path === "triggers/run") { const { commerceAccess } = await import("../../../../../lib/commerce/store.js"); const d = await commerceAccess({ orgId, membership: c.membership, need: "manage" }); if (d) return out(d); return json(await TRG.runTriggers({ orgId, dryRun: body.dryRun !== false })); }
    if (method === "POST" && path === "assistant/draft") return out(await AS.draftCampaign({ ...b, goal: body.goal, segmentId: body.segmentId }));
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error(`orgs/growth ${method} failed:`, path, err?.message); return json({ error: "Could not save." }, 500); }
}
export const POST = (req, a) => write(req, a.params, "POST");
export const PUT = (req, a) => write(req, a.params, "PUT");
