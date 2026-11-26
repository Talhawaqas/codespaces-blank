// src/lib/connect/tools.js -- SOW D and E: the tools each WhatsApp assistant may call. The model never touches the
// database: every tool runs server-side under the caller's real identity and scope.
//   Business (linked staff): the existing permission-scoped Business AI tools (read-only subset: no propose_*/guided
//     actions in this release) + read-only operational tools that reuse the authoritative modules: Commerce report
//     (sales, refunds), stock at my branches, Manage Orders status, orders waiting to dispatch, today's rota.
//   Customer (verified only): their own orders, repairs, appointments and invoices, published help articles, and a
//     request for a person. Never revenue, staff, suppliers, margins, notes or anyone else's records.
import { getOrgCollections } from "../orgs.js";
import { oid, sid, clean, nowIso } from "./core.js";

// ------------------------------------------------------------------ business
const READ_ONLY = (name) => !/^(propose_|start_guided|advance_guided|cancel_guided|set_guided)/.test(name);
export async function businessToolset() {
  const { BUSINESS_TOOL_DECLARATIONS } = await import("../ai-business-tools.js");
  return [...BUSINESS_TOOL_DECLARATIONS.filter((t) => READ_ONLY(t.name)), ...OPS_TOOLS];
}
const PERIOD = { type: "string", enum: ["today", "yesterday", "this_week", "last_week", "this_month", "last_month"], description: "Reporting period in the company's timezone." };
const OPS_TOOLS = [
  { name: "sales_summary", description: "Sales for a period from the Point of Sale and orders: number of sales, gross, discounts, refunds/returns, net, tax, total collected, payment methods. Respects the user's branches. Use for 'how much did we sell'.", parameters: { type: "object", properties: { period: PERIOD, compareWithPrevious: { type: "boolean" } }, required: ["period"] } },
  { name: "stock_at_my_branches", description: "Current stock (on hand, reserved, free) of a product at the branches the user may see. Search by name or SKU.", parameters: { type: "object", properties: { product: { type: "string" } }, required: ["product"] } },
  { name: "job_status", description: "Status of a work order or repair order by its number (WO-00012, RO-00004), with technician, schedule and last activity.", parameters: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } },
  { name: "orders_waiting_dispatch", description: "Sales/online orders confirmed but not yet dispatched or collected.", parameters: { type: "object", properties: {} } },
  { name: "scheduled_today", description: "Who is scheduled to work today (published rota) at the user's branches, and who is clocked in.", parameters: { type: "object", properties: {} } },
];
function bounds(period, tz) {
  const now = new Date(); const local = (d) => new Date(d.toLocaleString("en-US", { timeZone: tz })); const offset = local(now) - now;
  const startOfDay = (d) => { const x = local(d); x.setHours(0, 0, 0, 0); return new Date(x.getTime() - offset); };
  const today = startOfDay(now); const day = 86400000; const dow = (local(now).getDay() + 6) % 7;
  const monthStart = (() => { const x = local(now); x.setDate(1); x.setHours(0, 0, 0, 0); return new Date(x.getTime() - offset); })();
  const lastMonthStart = (() => { const x = local(now); x.setMonth(x.getMonth() - 1, 1); x.setHours(0, 0, 0, 0); return new Date(x.getTime() - offset); })();
  return ({ today: [today, now], yesterday: [new Date(today - day), today], this_week: [new Date(today - dow * day), now], last_week: [new Date(today - (dow + 7) * day), new Date(today - dow * day)], this_month: [monthStart, now], last_month: [lastMonthStart, monthStart] })[period] || [today, now];
}
/** Sales from invoices issued in the period (not drafts or cancelled), by currency; owners/admins and finance roles only. */
async function invoiceSales({ orgId, membership, period, from, to, tz, compare }) {
  const { canManageOrg } = await import("../orgs.js");
  if (!canManageOrg(membership) && !membership.financeRole) return { error: "Sales figures need an owner, admin or finance role." };
  const col = await getOrgCollections();
  const sum = async (f, t) => {
    const range = { $or: [{ issueDate: { $gte: f.toISOString(), $lt: t.toISOString() } }, { issueDate: { $gte: f, $lt: t } }] };
    const rows = await col.invoices.find({ orgId: oid(orgId), deletedAt: null, status: { $in: ["SENT", "PAID", "OVERDUE"] }, ...range }, { projection: { total: 1, currency: 1, status: 1 } }).limit(5000).toArray();
    const by = {}; for (const i of rows) { const k = i.currency || "?"; by[k] ||= { invoices: 0, total: 0, paid: 0, unpaid: 0 }; by[k].invoices++; by[k].total += Number(i.total) || 0; by[k][i.status === "PAID" ? "paid" : "unpaid"] += Number(i.total) || 0; }
    for (const v of Object.values(by)) for (const k of ["total", "paid", "unpaid"]) v[k] = Math.round(v[k] * 100) / 100;
    return { invoicesIssued: rows.length, byCurrency: by };
  };
  const out = { source: "invoices", note: "From invoices issued in the period (drafts and cancelled excluded). Point of Sale (Inaya Commerce) isn't enabled for this company.", period, from: from.toISOString(), to: to.toISOString(), timezone: tz, ...(await sum(from, to)) };
  if (compare) { const prev = { today: "yesterday", this_week: "last_week", this_month: "last_month" }[period]; if (prev) { const [f2, t2] = bounds(prev, tz); out.previous = { period: prev, ...(await sum(f2, t2)) }; } }
  return out;
}
export async function runOpsTool(name, args, ctx) {
  const { orgId, membership } = ctx; const col = await getOrgCollections();
  if (name === "sales_summary") {
    const { commerceReport, } = await import("../commerce/reports.js"); const { getSettings } = await import("../commerce/store.js");
    // Commerce's timezone when it has one; otherwise the company's Inaya Connect business-hours timezone.
    const { getSettings: connectSettings } = await import("./core.js");
    const ctz = await getSettings(orgId).then((s) => s?.timezone).catch(() => null);
    const tz = (ctz && ctz !== "UTC" ? ctz : null) || (await connectSettings(orgId)).hours?.timezone || ctz || "Asia/Karachi"; const [from, to] = bounds(args.period, tz);
    const r = await commerceReport({ orgId, membership, input: { from: from.toISOString(), to: to.toISOString() } });
    // No Point of Sale (Commerce off): companies that sell by invoice still get an answer, from invoices issued.
    if (r.error && /not enabled|isn't enabled|not available/i.test(r.error)) return invoiceSales({ orgId, membership, period: args.period, from, to, tz, compare: args.compareWithPrevious });
    if (r.error) return { error: r.error };
    const out = { period: args.period, from: r.period.from, to: r.period.to, timezone: r.period.timezone, currency: r.currency, ...r.totals, paymentMethods: r.paymentMethods, onlineOrders: r.orders, note: "Net = sales net of discounts minus returns; tax shown separately." };
    if (args.compareWithPrevious) { const prev = { today: "yesterday", this_week: "last_week", this_month: "last_month" }[args.period]; if (prev) { const [f2, t2] = bounds(prev, tz); const p = await commerceReport({ orgId, membership, input: { from: f2.toISOString(), to: t2.toISOString() } }); if (!p.error) out.previous = { period: prev, net: p.totals.net, sales: p.totals.sales, totalCollected: p.totals.totalCollected }; } }
    return out;
  }
  if (name === "stock_at_my_branches") {
    const { memberLocations } = await import("../workforce/scope.js"); const ids = memberLocations(membership);
    const rx = new RegExp(String(args.product || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i");
    const prods = await col.products.find({ orgId: oid(orgId), deletedAt: null, $or: [{ name: rx }, { sku: rx }] }, { projection: { name: 1, sku: 1 } }).limit(5).toArray();
    if (!prods.length) return { found: false };
    const lv = await col.stockLevels.find({ orgId: oid(orgId), productId: { $in: prods.map((p) => p._id) }, ...(ids ? { warehouseId: { $in: ids.map(oid) } } : {}) }).toArray();
    const wh = new Map((await col.warehouses.find({ orgId: oid(orgId) }, { projection: { name: 1 } }).toArray()).map((w) => [sid(w._id), w.name]));
    return { products: prods.map((p) => ({ name: p.name, sku: p.sku, branches: lv.filter((l) => sid(l.productId) === sid(p._id)).map((l) => ({ branch: wh.get(sid(l.warehouseId)) || "?", onHand: l.quantity, reserved: l.reserved || 0, free: (l.quantity || 0) - (l.reserved || 0) })) })) };
  }
  if (name === "job_status") {
    const { listJobs } = await import("../ops/jobs.js");
    const r = await listJobs({ orgId, membership, q: clean(args.number, 20).toUpperCase(), limit: 3 }); if (r.error) return { error: r.error };
    const j = r.jobs.find((x) => x.number === clean(args.number, 20).toUpperCase()) || r.jobs[0];
    return j ? { number: j.number, type: j.type === "RO" ? "Repair order" : "Work order", title: j.title, status: j.status, priority: j.priority, technicians: j.assignments.map((a) => a.email), plannedStart: j.plannedStart, due: j.dueAt, lastActivity: j.lastActivityAt } : { found: false };
  }
  if (name === "orders_waiting_dispatch") {
    const { memberLocations } = await import("../workforce/scope.js"); const ids = memberLocations(membership);
    const rows = await col.salesOrders.find({ orgId: oid(orgId), deletedAt: null, status: { $in: ["CONFIRMED", "BACKORDERED"] }, stage: { $nin: ["DISPATCHED", "DELIVERED", "COLLECTED"] }, ...(ids ? { warehouseId: { $in: ids.map(oid) } } : {}) }, { projection: { orderNumber: 1, status: 1, stage: 1, total: 1, currency: 1, createdAt: 1 } }).sort({ createdAt: 1 }).limit(25).toArray();
    return { count: rows.length, orders: rows.map((o) => ({ number: o.orderNumber, status: o.status, stage: o.stage || null, total: o.total, currency: o.currency, since: o.createdAt })) };
  }
  if (name === "scheduled_today") {
    const { rota } = await import("../workforce/time.js"); const { memberLocations } = await import("../workforce/scope.js");
    const day = new Date(); const monday = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7))).toISOString().slice(0, 10);
    const r = await rota({ orgId, membership, weekStart: monday }); if (r.error) return { error: r.error };
    const today = nowIso().slice(0, 10); const ids = memberLocations(membership);
    const shifts = (r.shifts || []).filter((s) => String(s.start).slice(0, 10) === today && (!ids || ids.includes(String(s.locationId))));
    return { date: today, shifts: shifts.map((s) => ({ person: s.email, start: s.start, end: s.end, role: s.role || null, status: s.status })) };
  }
  return { error: "Unknown tool." };
}

// ------------------------------------------------------------------ customer
export const CUSTOMER_TOOLS = [
  { name: "my_orders", description: "The verified customer's own recent orders with status and delivery/collection stage.", parameters: { type: "object", properties: {} } },
  { name: "my_repairs", description: "The verified customer's own repair orders and their status.", parameters: { type: "object", properties: {} } },
  { name: "my_appointments", description: "The verified customer's upcoming appointments.", parameters: { type: "object", properties: {} } },
  { name: "my_invoices", description: "The verified customer's invoices with number, amount, due date and status.", parameters: { type: "object", properties: {} } },
  { name: "help_articles", description: "Search the company's published help articles (store hours, delivery, services...).", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { name: "talk_to_a_person", description: "Hand the conversation to a staff member (complaints, disputes, payments, anything sensitive or unanswered).", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];
export async function runCustomerTool(name, args, ctx) {
  const { orgId, contactId } = ctx; const col = await getOrgCollections();
  if (name === "talk_to_a_person") return { handover: true, reason: clean(args.reason, 200) };
  if (name === "help_articles") { try { const { searchArticles } = await import("../support/kb.js"); const r = await searchArticles({ orgId, q: clean(args.question, 200), level: "PUBLIC", limit: 3, track: false }); return { articles: (r.articles || r.results || []).slice(0, 3).map((a) => ({ title: a.title, summary: clean(a.summary || a.body, 600) })) }; } catch { return { articles: [] }; } }
  if (!contactId) return { error: "The customer isn't verified.", needVerification: true };
  const cid = oid(contactId);
  if (name === "my_orders") return { orders: (await col.salesOrders.find({ orgId: oid(orgId), contactId: cid, deletedAt: null }, { projection: { orderNumber: 1, saleNumber: 1, status: 1, stage: 1, total: 1, currency: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(5).toArray()).map((o) => ({ number: o.orderNumber || o.saleNumber, status: o.status, stage: o.stage || null, total: o.total, currency: o.currency, date: String(o.createdAt).slice(0, 10) })) };
  if (name === "my_repairs") { const { ccol, K } = await import("../ops/core.js"); const c = await ccol(); return { repairs: (await c.find({ orgId: oid(orgId), kind: K.job, type: "RO", contactId: cid, archived: { $ne: true } }, { projection: { number: 1, status: 1, title: 1, "intake.expectedAt": 1, updatedAt: 1 } }).sort({ createdAt: -1 }).limit(5).toArray()).map((j) => ({ number: j.number, item: j.title, status: j.status, expectedReady: j.intake?.expectedAt || null, updated: String(j.updatedAt).slice(0, 10) })) }; }
  if (name === "my_invoices") return { invoices: (await col.invoices.find({ orgId: oid(orgId), contactId: cid, deletedAt: null, status: { $ne: "DRAFT" } }, { projection: { invoiceNumber: 1, total: 1, currency: 1, dueDate: 1, status: 1 } }).sort({ createdAt: -1 }).limit(5).toArray()).map((i) => ({ number: i.invoiceNumber, total: i.total, currency: i.currency, due: i.dueDate, status: i.status })) };
  if (name === "my_appointments") { try { const { db } = col; const rows = await db.collection("calendar_records").find({ orgId: oid(orgId), kind: "appointment", contactId: cid, start: { $gte: new Date() } }, { projection: { typeName: 1, title: 1, start: 1, status: 1 } }).sort({ start: 1 }).limit(5).toArray(); return { appointments: rows.map((a) => ({ what: a.typeName || a.title || "Appointment", when: a.start, status: a.status })) }; } catch { return { appointments: [] }; } }
  return { error: "Unknown tool." };
}
