// src/lib/whyInaya/savings.js -- deterministic arithmetic for the Why Inaya explainer (SOW section 6). Pure functions, no I/O.
// The AI never computes prices or savings: it only words what this module returns. The same result object feeds the
// on-screen figures, the narration script and the transcript, so they can never disagree.
//
// Inputs are the visitor's own answers (all optional). Prices come from pricingFacts() (canonical pricing code).

export const CATEGORIES = { accounting: "Accounting / bookkeeping", pos: "Point of sale", inventory: "Inventory", ecommerce: "E-commerce platform", crm: "CRM / loyalty / email", hr: "HR / payroll / rosters", documents: "Documents / file storage", backup: "Backup", other: "Other" };
export const INDUSTRIES = { retail: "Retail shop", multibranch: "Multi-branch retail", wholesale: "Wholesale or distribution", restaurant: "Restaurant or cafe", ecommerce: "Online shop", services: "Professional services", clinic: "Clinic or healthcare", school: "School or training", manufacturing: "Manufacturing", other: "Other" };
export const CHALLENGES = { disconnected: "Too many disconnected systems", inventory: "Stock and inventory visibility", bookkeeping: "Manual bookkeeping", retention: "Keeping customers coming back", omnichannel: "Running shop and online together", data_protection: "Protecting our data" };
export const STAFF_BANDS = { "1-2": 2, "3-5": 5, "6-10": 10, "11-25": 25, "26+": 26 };
export const BRANCH_BANDS = { "1": 1, "2": 2, "3-5": 5, "6+": 6 };
export const ORDER_BANDS = { none: 0, "1-300": 300, "301-1000": 1000, "1001-2000": 2000, "2001-4000": 4000, "4000+": 4001 };
export const MAX_COST = 1_000_000; // per tool, per month: anything larger is treated as a typing mistake
const round2 = (n) => Math.round(n * 100) / 100;

/** Cleans untrusted answers into a known shape. Unknown values become null ("not sure"). */
export function normaliseAnswers(a = {}) {
  const pick = (v, allowed) => (Object.prototype.hasOwnProperty.call(allowed, v) ? v : null);
  const num = (v, max) => { if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
  const region = a.region === "PK" ? "PK" : a.region === "INTL" ? "INTL" : null;
  const channels = Array.isArray(a.channels) ? [...new Set(a.channels.filter((c) => ["own_site", "shopify", "woocommerce", "marketplace", "none"].includes(c)))] : [];
  const tools = (Array.isArray(a.tools) ? a.tools : []).slice(0, 12).map((t) => ({ category: pick(t?.category, CATEGORIES), monthlyCost: num(t?.monthlyCost, MAX_COST) })).filter((t) => t.category && t.monthlyCost !== null);
  const t = a.time || {};
  const time = { hoursPerWeek: num(t.hoursPerWeek, 168), people: num(t.people, 1000), hourlyCost: num(t.hourlyCost, 100000), reductionPct: num(t.reductionPct, 100) };
  return {
    region,
    industry: pick(a.industry, INDUSTRIES),
    staff: pick(a.staff, STAFF_BANDS),
    branches: pick(a.branches, BRANCH_BANDS),
    sellsInPerson: a.sellsInPerson === true, sellsOnline: a.sellsOnline === true,
    channels, orders: pick(a.orders, ORDER_BANDS), tools, time,
    challenge: pick(a.challenge, CHALLENGES),
  };
}

/**
 * Picks the smallest Inaya configuration that covers the answers and prices it. Returns lines that add up to the total.
 * prices = pricingFacts(). Currency follows the visitor's chosen region (never inferred).
 */
export function recommendConfig(ans, prices) {
  const cur = ans.region === "PK" ? "PKR" : "USD"; const P = cur === "PKR" ? prices.pkr : prices.usd;
  const users = STAFF_BANDS[ans.staff] ?? 5; const branches = BRANCH_BANDS[ans.branches] ?? 1; const orders = ORDER_BANDS[ans.orders] ?? 0;
  const shopify = ans.channels.includes("shopify"), woo = ans.channels.includes("woocommerce");
  const commerce = ans.sellsInPerson || ans.sellsOnline || shopify || woo || ans.channels.includes("own_site");
  const notes = []; const lines = [];
  const options = [];
  // Candidate A: Professional + Commerce Starter (1 branch, 1 till, ONE connected store, 300 synced orders)
  // Candidate B: Business (+ Commerce add-on as the bundle): 2 branches, 3 tills, 1 Shopify + 1 WooCommerce, 1,000 orders
  // Candidate C: Enterprise: Commerce included, unlimited branches, tills and orders
  // Without Commerce: Starter / Professional / Business / Enterprise by users.
  const ob = prices.commerce.orderBlock;
  const blocksFor = (base) => (orders <= base ? 0 : Math.ceil((orders - base) / ob.orders));
  if (!commerce) {
    const plan = users <= prices.users.starter ? "starter" : users <= prices.users.professional ? "professional" : users <= prices.users.business ? "business" : "enterprise";
    options.push({ plan, lines: [{ label: `${cap(plan)} package`, amount: P[plan] }] });
  } else {
    if (users <= prices.users.professional && branches <= 1 && !(shopify && woo)) {
      const blocks = blocksFor(prices.commerce.starter.monthlyOrders);
      if (blocks <= ob.maxBlocks) options.push({ plan: "professional", lines: [{ label: "Professional package", amount: P.professional }, { label: "Commerce Starter", amount: P.commerceStarter }, ...(blocks ? [{ label: `${blocks} extra 1,000-order block${blocks > 1 ? "s" : ""}`, amount: blocks * P.orderBlock }] : [])] });
    }
    if (users <= prices.users.business) {
      const blocks = blocksFor(prices.commerce.addon.monthlyOrders); const extraBranches = Math.max(0, branches - prices.commerce.addon.branches);
      if (blocks <= ob.maxBlocks) options.push({ plan: "business", lines: [{ label: "Business + Commerce bundle", amount: P.bundle }, ...(extraBranches ? [{ label: `${extraBranches} extra branch${extraBranches > 1 ? "es" : ""}`, amount: extraBranches * P.extraBranch }] : []), ...(blocks ? [{ label: `${blocks} extra 1,000-order block${blocks > 1 ? "s" : ""}`, amount: blocks * P.orderBlock }] : [])] });
    }
    options.push({ plan: "enterprise", lines: [{ label: "Enterprise package (Commerce included)", amount: P.enterprise }] });
  }
  const total = (o) => o.lines.reduce((s, l) => s + l.amount, 0);
  const best = options.reduce((a, b) => (total(b) < total(a) ? b : a));
  lines.push(...best.lines);
  if (users > prices.users.enterprise) notes.push(`More than ${prices.users.enterprise} staff: Enterprise is quoted with extra users; contact us for the exact figure.`);
  if (ans.branches === "6+" || ans.staff === "26+") notes.push("Your answer was an open-ended range, so the figure is a starting point, not a quote.");
  if (ans.channels.includes("marketplace")) notes.push("Marketplace connectors are not included in this estimate.");
  if (commerce) notes.push("Card payments use your own Stripe or Safepay account; their fees are not included.");
  return { currency: cur, plan: best.plan, commerce, lines, monthlyTotal: round2(lines.reduce((s, l) => s + l.amount, 0)), notes };
}

/** Builds the full, validated result object used by the visual, the narration and the transcript. */
export function computeResult(rawAnswers, prices) {
  const ans = normaliseAnswers(rawAnswers);
  const config = recommendConfig(ans, prices);
  const current = ans.tools.length ? round2(ans.tools.reduce((s, t) => s + t.monthlyCost, 0)) : null;
  const consolidation = current === null ? null : { currentMonthly: current, inayaMonthly: config.monthlyTotal, difference: round2(current - config.monthlyTotal), categories: [...new Set(ans.tools.map((t) => t.category))] };
  const t = ans.time; let time = null;
  if (t.hoursPerWeek !== null && t.people !== null && t.hourlyCost !== null) {
    const currentMonthlyCost = round2(t.hoursPerWeek * t.people * t.hourlyCost * 52 / 12);
    time = { hoursPerWeek: t.hoursPerWeek, people: t.people, hourlyCost: t.hourlyCost, currentMonthlyCost, reductionPct: t.reductionPct, hypotheticalMonthlyValue: t.reductionPct === null ? null : round2(currentMonthlyCost * t.reductionPct / 100) };
  }
  return { answers: ans, config, consolidation, time, currency: config.currency, scenarios: pickScenarios(ans) };
}

/** Which verified workflows to show (SOW 5.4). Max two, chosen from the answers. */
export function pickScenarios(ans) {
  const s = [];
  const online = ans.sellsOnline || ans.channels.some((c) => ["shopify", "woocommerce", "own_site"].includes(c));
  if (ans.sellsInPerson) s.push("retail");
  if (online) s.push("omnichannel");
  if (!ans.sellsInPerson && !online) s.push("service");
  if (ans.challenge === "data_protection" || s.length < 2) s.push("resilience");
  return [...new Set(s)].slice(0, 2);
}

export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined) return "";
  const neg = amount < 0; const v = Math.abs(amount);
  const txt = currency === "PKR" ? `PKR ${Math.round(v).toLocaleString("en-US")}` : `$${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  return neg ? `-${txt}` : txt;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
