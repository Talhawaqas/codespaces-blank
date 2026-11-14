// app/api/orgs/campaigns/[[...path]]/route.js -- Mass Marketing Email (Business Workspace, Business and Enterprise plans).
// Session + membership, then the plan gate, then routing. Role checks (editor / approver / manager) live in src/lib/engagement/*.
//
//   GET overview ?days     GET options      GET|PUT settings      PUT roles { email, marketingRole|null }
//   GET|POST templates     PATCH templates/{id}
//   GET|POST segments      PATCH segments/{id}      POST audience/preview { rules | segmentId }
//   GET|POST campaigns     GET|PATCH campaigns/{id}  GET campaigns/{id}/review | report
//   POST campaigns/{id}/submit | approve { note } | reject { note } | cancel | duplicate | test { to[] }
//   GET|POST sequences     PATCH sequences/{id}      POST sequences/{id}/submit | approve | reject | pause | enroll { email, name, contactId }
//   GET enrollments ?sequenceId&status            POST enrollments/{id}/stop
//   GET|POST suppressions  (POST { email, reason:"manual" } | { importText })     DELETE suppressions { email }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { engagementAccess, setEngagementRole, MARKETING_ROLES, canManageMarketing, canEditCampaigns, canApproveCampaigns, canViewCampaigns, listOrgMembers, fail } from "../../../../../lib/engagement/store.js";
import * as C from "../../../../../lib/engagement/campaigns.js";
import * as T from "../../../../../lib/engagement/templates.js";
import * as G from "../../../../../lib/engagement/segments.js";
import * as Q from "../../../../../lib/engagement/sequences.js";
import * as S from "../../../../../lib/engagement/suppression.js";
import { senderStatus, monthlyUsage } from "../../../../../lib/engagement/sender.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error }, r.status || 400) : json(r, ok));

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const q = Object.fromEntries(new URL(req.url).searchParams.entries()); let body = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const gate = await engagementAccess(orgId, "campaigns"); if (gate) return json({ error: gate.error, upgrade: true }, gate.status);
    const membership = auth.membership, actorEmail = auth.session.email; const base = { orgId, membership, actorEmail }; const [a, b, c] = path;

    if (a === "options" && method === "GET") {
      const members = canManageMarketing(membership) ? (await listOrgMembers(orgId)).map((m) => ({ email: m.email, name: m.name || "", marketingRole: m.marketingRole || null })) : [];
      return json({ roles: MARKETING_ROLES, marketingRole: membership.marketingRole || null, can: { view: canViewCampaigns(membership), edit: canEditCampaigns(membership), approve: canApproveCampaigns(membership), manage: canManageMarketing(membership) }, sender: senderStatus(), usage: canViewCampaigns(membership) ? await monthlyUsage(orgId) : null, useCases: T.USE_CASES, mergeFields: T.MERGE_FIELDS, blockTypes: T.BLOCK_TYPES, statuses: C.CAMPAIGN_STATUSES, members, me: actorEmail });
    }
    if (a === "overview" && method === "GET") return out(await C.marketingOverview({ ...base, days: q.days }));
    if (a === "settings") {
      if (method === "GET") return canViewCampaigns(membership) ? json({ settings: await S.getMarketingSettings(orgId) }) : json({ error: "You need a marketing role." }, 403);
      if (method === "PUT") return out(await S.updateMarketingSettings({ ...base, updates: body }));
    }
    if (a === "roles" && method === "PUT") return out(await setEngagementRole({ orgId, membership, email: body.email, field: "marketingRole", value: body.marketingRole ?? null }));
    if (a === "templates") {
      if (!b && method === "GET") return canViewCampaigns(membership) ? out(await T.listTemplates(orgId)) : json({ error: "You need a marketing role." }, 403);
      if (!b && method === "POST") return out(await T.saveTemplate({ ...base, ...body, orgId, templateId: null }), 201);
      if (b && method === "PATCH") return out(await T.saveTemplate({ ...base, ...body, orgId, templateId: b }));
    }
    if (a === "segments") {
      if (!b && method === "GET") return out(await G.listSegments(base));
      if (!b && method === "POST") return out(await G.saveSegment({ ...base, name: body.name, rules: body.rules }), 201);
      if (b && method === "PATCH") return out(await G.saveSegment({ ...base, segmentId: b, name: body.name, rules: body.rules, archived: body.archived }));
    }
    if (a === "audience" && b === "preview" && method === "POST") return out(await G.previewAudience({ ...base, rules: body.rules, segmentId: body.segmentId }));
    if (a === "campaigns") {
      if (!b && method === "GET") return out(await C.listCampaigns({ ...base, status: q.status }));
      if (!b && method === "POST") return out(await C.createCampaign({ ...base, name: body.name, useCase: body.useCase, templateId: body.templateId }), 201);
      if (b && !c && method === "GET") return out(await C.getCampaign({ ...base, campaignId: b }));
      if (b && !c && method === "PATCH") { const { orgId: _o, ...updates } = body; return out(await C.updateCampaign({ ...base, campaignId: b, updates })); }
      if (b && c === "review" && method === "GET") return out(await C.reviewCampaign({ ...base, campaignId: b }));
      if (b && c === "report" && method === "GET") return out(await C.campaignReport({ ...base, campaignId: b }));
      if (b && c === "submit" && method === "POST") return out(await C.submitCampaign({ ...base, campaignId: b }));
      if (b && c === "approve" && method === "POST") return out(await C.decideCampaign({ ...base, campaignId: b, approve: true, note: body.note }));
      if (b && c === "reject" && method === "POST") return out(await C.decideCampaign({ ...base, campaignId: b, approve: false, note: body.note }));
      if (b && c === "cancel" && method === "POST") return out(await C.cancelCampaign({ ...base, campaignId: b }));
      if (b && c === "duplicate" && method === "POST") return out(await C.duplicateCampaign({ ...base, campaignId: b }), 201);
      if (b && c === "test" && method === "POST") return out(await C.testSendCampaign({ ...base, campaignId: b, to: body.to }));
    }
    if (a === "sequences") {
      if (!b && method === "GET") return out(await Q.listSequences(base));
      if (!b && method === "POST") return out(await Q.saveSequence({ ...base, name: body.name, steps: body.steps, exitOnBooking: body.exitOnBooking }), 201);
      if (b && !c && method === "PATCH") return out(await Q.saveSequence({ ...base, sequenceId: b, name: body.name, steps: body.steps, exitOnBooking: body.exitOnBooking, archived: body.archived }));
      if (b && c === "submit" && method === "POST") return out(await Q.submitSequence({ ...base, sequenceId: b }));
      if (b && c === "approve" && method === "POST") return out(await Q.decideSequence({ ...base, sequenceId: b, approve: true, note: body.note }));
      if (b && c === "reject" && method === "POST") return out(await Q.decideSequence({ ...base, sequenceId: b, approve: false, note: body.note }));
      if (b && c === "pause" && method === "POST") return out(await Q.pauseSequence({ ...base, sequenceId: b }));
      if (b && c === "enroll" && method === "POST") return out(await Q.enrollContact({ ...base, sequenceId: b, email: body.email, name: body.name, company: body.company, contactId: body.contactId, source: `added by ${actorEmail}` }));
    }
    if (a === "enrollments") {
      if (!b && method === "GET") return out(await Q.listEnrollments({ ...base, sequenceId: q.sequenceId, status: q.status }));
      if (b && c === "stop" && method === "POST") return out(await Q.stopEnrollment({ ...base, enrollmentId: b }));
    }
    if (a === "suppressions") {
      if (method === "GET") return out(await S.listSuppressions({ ...base, q: q.q }));
      if (method === "POST" && body.importText) return out(await S.importSuppressions({ ...base, text: body.importText }));
      if (method === "POST") return canManageMarketing(membership) ? out(await S.suppress({ orgId, email: body.email, reason: "manual", source: "added by hand", actorEmail })) : out(fail("Only a marketing manager, admin or owner can add to the suppression list.", 403));
      if (method === "DELETE") return out(await S.unsuppress({ ...base, email: body.email }));
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("campaigns route failed:", err?.message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

export const GET = handle; export const POST = handle; export const PUT = handle; export const PATCH = handle; export const DELETE = handle;
