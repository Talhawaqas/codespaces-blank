// src/lib/engagement/assistant.js
//
// Read-only AI Business Assistant tool for the Appointments & Campaigns SOW
// ("what's on my calendar tomorrow", "how did the November newsletter do",
// "any enquiries waiting"). Scoped exactly like the app: own calendar for
// everyone, team view for calendar managers, campaigns only with a marketing
// role, and nothing at all without the Business/Enterprise plan.

import { canManageCalendar, canViewCampaigns, engagementAccess } from "./store.js";
import { listAppointments } from "./appointments.js";
import { appointmentDashboard } from "./stats.js";
import { listEnquiries } from "./booking.js";
import { listCampaigns, marketingOverview, campaignReport } from "./campaigns.js";

export const ENGAGEMENT_TOPICS = ["schedule", "appointment_stats", "enquiries", "campaigns", "campaign_report", "marketing_overview"];

export async function engagementAssistantTool(args, ctx) {
  const topic = ENGAGEMENT_TOPICS.includes(args?.topic) ? args.topic : "schedule";
  const marketing = ["campaigns", "campaign_report", "marketing_overview"].includes(topic);
  const gate = await engagementAccess(String(ctx.orgId), marketing ? "campaigns" : "appointments");
  if (gate) return { error: gate.error };
  const base = { orgId: String(ctx.orgId), membership: ctx.membership };
  if (topic === "schedule") {
    const from = args?.from ? new Date(args.from) : new Date();
    const to = args?.to ? new Date(args.to) : new Date(from.getTime() + 7 * 86400000);
    const scope = args?.team === true && canManageCalendar(ctx.membership) ? "team" : "mine";
    const r = await listAppointments({ ...base, scope, from, to, status: "PENDING,CONFIRMED,COMPLETED,NO_SHOW" });
    if (r.error) return r;
    return { topic, scope, from: r.from, to: r.to, appointments: r.appointments.slice(0, 50).map((a) => ({ id: a.id, type: a.typeName, start: a.start, end: a.end, status: a.status, customer: a.customer.name, customerEmail: a.customer.email, staff: a.staffEmail, where: a.location?.joinLink ? "online" : a.location?.kind })) };
  }
  if (topic === "appointment_stats") {
    const r = await appointmentDashboard({ ...base, scope: canManageCalendar(ctx.membership) ? "team" : "mine", period: ["week", "month", "quarter"].includes(args?.period) ? args.period : "month" });
    return { topic, cards: r.cards, rates: r.rates, funnel: r.funnel, period: r.period, scope: r.scope };
  }
  if (topic === "enquiries") {
    const r = await listEnquiries({ ...base, status: args?.status || "NEW" });
    if (r.error) return r;
    return { topic, enquiries: r.enquiries.slice(0, 30).map((q) => ({ name: q.name, email: q.email, company: q.company, message: q.message.slice(0, 400), status: q.status, at: q.createdAt })) };
  }
  if (!canViewCampaigns(ctx.membership)) return { error: "You don't have a marketing role, so I can't show email campaigns." };
  if (topic === "campaigns") {
    const r = await listCampaigns({ ...base, status: args?.status });
    if (r.error) return r;
    return { topic, campaigns: r.campaigns.slice(0, 30).map((c) => ({ id: c.id, name: c.name, status: c.status, subject: c.subject, nextRunAt: c.nextRunAt, stats: c.stats, rates: c.rates })) };
  }
  if (topic === "campaign_report") {
    let id = args?.campaignId;
    if (!id && args?.search) {
      const all = await listCampaigns(base);
      id = all.campaigns?.find((c) => c.name.toLowerCase().includes(String(args.search).toLowerCase()))?.id;
    }
    if (!id) return { error: "Tell me which campaign (its name)." };
    const r = await campaignReport({ ...base, campaignId: id });
    if (r.error) return r;
    return { topic, campaign: { name: r.campaign.name, status: r.campaign.status, stats: r.campaign.stats, rates: r.campaign.rates }, topLinks: r.links.slice(0, 5), note: r.note };
  }
  return { topic, ...(await marketingOverview({ ...base, days: Number(args?.days) || 30 })) };
}
