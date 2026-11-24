// src/lib/whyInaya/script.js -- turns ONE validated result (savings.js) + validated AI wording into the scenes the avatar
// presents, the narration it speaks and the transcript shown on screen (SOW 5.3-5.5). Pure: used by the server (to sign
// the script for text-to-speech) and by the browser (to render it), so all three are always identical.
// Every number in the narration is inserted here from the result object; AI wording may contain no digits at all.
import { CAPABILITIES, STATE_LABEL } from "./content.js";
import { formatMoney, INDUSTRIES, CHALLENGES } from "./savings.js";

export const SCENARIOS = {
  retail: { title: "An in-store sale", steps: ["A customer buys at the till", "The sale is recorded on that till's shift", "Stock goes down in that branch", "The customer's profile and loyalty update", "The sale is posted to the books", "It shows in branch and company reports"], caps: ["pos", "inventory", "crm", "finance"] },
  omnichannel: { title: "An online order", steps: ["Products and stock live in Inaya", "They are listed on your web store, Shopify or WooCommerce", "An order arrives: web-store orders at once, Shopify and WooCommerce orders synced in the background", "Stock comes off the same count the till uses", "You fulfil the order", "The sale is posted to the books"], caps: ["store", "sync", "inventory", "finance"] },
  service: { title: "A service job", steps: ["The customer is in your CRM", "You send a quote or order", "It goes through approval", "The invoice and payment are recorded", "Documents are filed, encrypted on your device", "It shows in finance reports"], caps: ["crm", "finance", "docs", "audit"] },
  resilience: { title: "Recovering from ransomware", steps: ["Documents are encrypted on your device", "They are stored with immutable snapshots", "Unusual mass-encryption activity is detected", "Affected access is contained", "You pick a clean recovery point", "Data is restored and checked"], caps: ["docs", "resilience"] },
};

export const AI_LIMITS = { profileSummary: 260, why: 200, consolidation: 260, closing: 200, maxFit: 5 };
// Wording rules: no digits or currency (numbers come only from code), no links or markup, no guarantees or superlatives.
const BANNED = /[0-9$€£¥₹%<>{}]|https?:|www\.|\bPKR\b|\bUSD\b|guarantee|guaranteed|real[- ]?time|instant|definitely|certainly will|best in|number one|#1|the only\b|100 ?percent|never fail|cancel your/i;
const clean = (s, max) => { if (typeof s !== "string") return null; const t = s.replace(/\s+/g, " ").trim(); return t && t.length <= max && !BANNED.test(t) ? t : null; };

/** Validates the AI's wording. Anything that fails is dropped (the caller then uses the template wording). */
export function validateAiWording(raw, allowedCaps) {
  const out = { profileSummary: clean(raw?.profileSummary, AI_LIMITS.profileSummary), consolidation: clean(raw?.consolidation, AI_LIMITS.consolidation), closing: clean(raw?.closing, AI_LIMITS.closing), fit: [] };
  const seen = new Set();
  for (const f of Array.isArray(raw?.fit) ? raw.fit.slice(0, AI_LIMITS.maxFit) : []) {
    const why = clean(f?.why, AI_LIMITS.why);
    if (why && allowedCaps.includes(f?.capability) && !seen.has(f.capability)) { seen.add(f.capability); out.fit.push({ capability: f.capability, why }); }
  }
  return out;
}

/** Capabilities that may be mentioned for these answers (the AI chooses only from these). */
export function allowedCapabilities(result) {
  const caps = new Set(["finance", "hr", "inventory", "crm", "docs", "resilience", "audit", "aiOps", "bookkeeper"]);
  for (const s of result.scenarios) for (const c of SCENARIOS[s].caps) caps.add(c);
  if (result.config.commerce) { caps.add("pos"); caps.add("offline"); }
  if (result.answers.channels.some((c) => c === "shopify" || c === "woocommerce")) caps.add("sync");
  if (result.answers.sellsOnline || result.answers.channels.includes("own_site")) caps.add("store");
  return [...caps];
}

function templateWording(result) {
  const a = result.answers; const bits = [];
  const PHRASE = { retail: "a retail shop", multibranch: "a retailer with several branches", wholesale: "a wholesale or distribution business", restaurant: "a restaurant or cafe", ecommerce: "an online shop", services: "a professional services firm", clinic: "a clinic or healthcare practice", school: "a school or training centre", manufacturing: "a manufacturer" };
  if (a.industry && PHRASE[a.industry]) bits.push(PHRASE[a.industry]);
  if (a.sellsInPerson && (a.sellsOnline || a.channels.length)) bits.push("selling in person and online"); else if (a.sellsInPerson) bits.push("selling in person"); else if (a.sellsOnline) bits.push("selling online");
  const order = ["pos", "sync", "store", "inventory", "finance", "resilience", "crm", "hr"]; const allowed = allowedCapabilities(result);
  const fitCaps = order.filter((c) => allowed.includes(c)).slice(0, 4);
  return {
    profileSummary: (bits.length ? `You told us you are ${bits.join(", ")}.` : "You chose not to share many details, so this is a general walkthrough.") + (a.challenge ? ` Your main challenge: ${CHALLENGES[a.challenge].toLowerCase()}.` : ""),
    fit: fitCaps.map((c) => ({ capability: c, why: CAPABILITIES[c].text })),
    consolidation: "Inaya could consolidate parts of the tools you use today into one system, so records are entered once.",
    closing: "If this looks useful, try it with a free trial or ask us for a live demo.",
  };
}

/**
 * Builds scenes + narration. `ai` is validated wording (may be partly empty); missing parts fall back to templates.
 * Returns { scenes: [{ id, kind, title, text, data }], transcript } -- scene.text is exactly what is spoken.
 */
export function buildScript(result, ai = {}) {
  const T = templateWording(result); const cur = result.currency; const m = (n) => formatMoney(n, cur);
  const fit = ai.fit?.length ? ai.fit : T.fit;
  const scenes = [];
  scenes.push({ id: "intro", kind: "intro", title: "Your walkthrough", text: `Hello. I'm the Inaya guide, an AI-assisted explainer, not a person. In about a minute I'll show how Inaya Business OS could fit your business, using only what you told me. ${ai.profileSummary || T.profileSummary}` });
  scenes.push({ id: "fit", kind: "capabilities", title: "What fits your answers", text: fit.map((f) => `${CAPABILITIES[f.capability].name}: ${f.why}`).join(" "), data: fit.map((f) => ({ ...f, name: CAPABILITIES[f.capability].name, state: STATE_LABEL[CAPABILITIES[f.capability].state] })) });
  for (const s of result.scenarios) { const sc = SCENARIOS[s]; scenes.push({ id: `flow-${s}`, kind: "workflow", title: sc.title, text: s === "resilience" ? `Here is how recovery from ransomware works in Inaya. ${sc.steps.join(". ")}.` : `Here is how ${sc.title.charAt(0).toLowerCase() + sc.title.slice(1)} moves through Inaya. ${sc.steps.join(". ")}.`, data: { scenario: s, steps: sc.steps } }); }
  const c = result.config;
  let costText = `For what you described, the starting configuration is ${c.lines.map((l) => `${l.label} at ${m(l.amount)}`).join(", ")}, about ${m(c.monthlyTotal)} a month in total.`;
  if (result.consolidation) {
    const k = result.consolidation;
    costText += ` You entered ${m(k.currentMonthly)} a month for your current tools. ${k.difference >= 0 ? `That is ${m(k.difference)} a month more than this Inaya configuration.` : `That is ${m(-k.difference)} a month less than this Inaya configuration, so the case here rests on fewer systems rather than a lower bill.`} ${ai.consolidation || T.consolidation}`;
  } else costText += " You didn't enter what you pay today, so I won't guess a saving.";
  scenes.push({ id: "cost", kind: "cost", title: "Illustrative cost", text: costText, data: { config: c, consolidation: result.consolidation } });
  if (result.time) {
    const t = result.time;
    const tt = `You estimated ${t.hoursPerWeek} hours a week across ${t.people} ${t.people === 1 ? "person" : "people"} at ${m(t.hourlyCost)} an hour: about ${m(t.currentMonthlyCost)} of time a month.${t.hypotheticalMonthlyValue !== null ? ` If, as you assumed, that fell by ${t.reductionPct} percent, that would be worth about ${m(t.hypotheticalMonthlyValue)} a month. That is your assumption, not a measured result.` : ""}`;
    scenes.push({ id: "time", kind: "time", title: "Time on manual work", text: tt, data: t });
  }
  const lim = [];
  if (c.commerce) lim.push("The till, web store and Shopify or WooCommerce sync need Inaya Commerce on your package.");
  if (allowedCapabilities(result).includes("offline")) lim.push("Offline selling and till hardware are in Beta with pilot shops; offline selling is cash only and a manager switches it on.");
  lim.push(...c.notes);
  lim.push("These are estimates from your answers and our published prices, not a quote or a guarantee of savings.");
  scenes.push({ id: "limits", kind: "limits", title: "Good to know", text: lim.join(" "), data: lim });
  scenes.push({ id: "next", kind: "next", title: "Next step", text: ai.closing || T.closing, data: { plan: c.plan } });
  return { scenes, transcript: scenes.map((s) => `${s.title}. ${s.text}`).join("\n\n") };
}
