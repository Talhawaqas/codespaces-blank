// src/lib/engagement/templates.js
//
// Mass Marketing Email SOW — the campaign design step: block-based email
// templates (no raw HTML from users, so nothing they type can break the
// layout or inject script), personalisation merge fields, and five starter
// templates for the SOW's use cases (newsletter, promotional, re-engagement,
// product update, event invitation). Rendering produces table-based HTML
// that works in Outlook, Gmail and Apple Mail, plus a plain-text part.

import { toObjectId } from "../orgs.js";
import { engagementCollections, ensureEngagementIndexes, oid, nowIso, fail, clean, canEditCampaigns } from "./store.js";
import { esc } from "./messages.js";

export const BLOCK_TYPES = ["heading", "text", "button", "image", "divider", "spacer", "columns"];
export const MERGE_FIELDS = {
  first_name: "First name", name: "Full name", email: "Email", company: "Company",
  business_name: "Your business name", booking_url: "Your booking page", unsubscribe_url: "Unsubscribe link (added automatically too)",
};
const MAX_BLOCKS = 40;

/** {{first_name|there}} -> value, or the fallback after the pipe. Unknown fields render empty. */
export function mergeText(template, vars, { html = false } = {}) {
  return String(template ?? "").replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_, key, fallback) => {
    const v = vars[key.toLowerCase()];
    const out = v === undefined || v === null || v === "" ? (fallback ?? "") : String(v);
    return html ? esc(out) : out;
  });
}

/** Minimal inline formatting for text blocks: **bold**, *italic*, [label](https://url), blank line = paragraph. */
function inline(text, vars, linkWrap) {
  let s = esc(mergeText(text, vars));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]{1,200})\]\((https:\/\/[^\s)]{1,1000})\)/g, (_, label, url) => `<a href="${esc(linkWrap(url.replace(/&amp;/g, "&")))}" style="color:#0b6e75">${label}</a>`);
  return s;
}

export function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return { error: "Add at least one block to the email." };
  if (blocks.length > MAX_BLOCKS) return { error: `${MAX_BLOCKS} blocks at most.` };
  const out = [];
  for (const b of blocks) {
    if (!BLOCK_TYPES.includes(b?.type)) return { error: `Unknown block type "${b?.type}".` };
    const x = { type: b.type };
    if (b.type === "heading") { x.text = clean(b.text, 200); x.level = b.level === 2 ? 2 : 1; if (!x.text) return { error: "A heading block is empty." }; }
    if (b.type === "text") { x.text = clean(b.text, 5000); if (!x.text) return { error: "A text block is empty." }; }
    if (b.type === "button") {
      x.label = clean(b.label, 60); x.url = clean(b.url, 1000);
      if (!x.label) return { error: "A button needs a label." };
      if (!/^https:\/\/\S+$/i.test(x.url) && !/^\{\{\s*booking_url\s*\}\}$/.test(x.url)) return { error: "Button links must start with https:// (or use {{booking_url}})." };
    }
    if (b.type === "image") {
      x.src = clean(b.src, 1000); x.alt = clean(b.alt, 200); x.href = clean(b.href, 1000);
      if (!/^https:\/\/\S+$/i.test(x.src)) return { error: "Images must be https:// links." };
      if (x.href && !/^https:\/\/\S+$/i.test(x.href)) return { error: "Image links must start with https://." };
    }
    if (b.type === "spacer") x.height = Math.min(Math.max(Number(b.height) || 16, 4), 80);
    if (b.type === "columns") {
      x.left = clean(b.left, 2000); x.right = clean(b.right, 2000);
      if (!x.left && !x.right) return { error: "A two-column block is empty." };
    }
    out.push(x);
  }
  return { blocks: out };
}

/**
 * Renders blocks into { html, text }.
 * linkWrap(url) lets the sender rewrite links for click tracking; footer carries the unsubscribe link and postal address.
 */
export function renderEmail({ blocks, vars = {}, preheader = "", brandColor = "#0b6e75", footer = {}, linkWrap = (u) => u, openPixelUrl = null }) {
  const rows = []; const text = [];
  for (const b of blocks) {
    if (b.type === "heading") { const t = mergeText(b.text, vars); rows.push(`<tr><td style="padding:8px 28px 4px"><h${b.level} style="margin:0;font-size:${b.level === 1 ? 24 : 18}px;line-height:1.3;color:#1d2433">${esc(t)}</h${b.level}></td></tr>`); text.push(t.toUpperCase(), ""); }
    if (b.type === "text") {
      const paras = String(b.text).split(/\n{2,}/);
      rows.push(`<tr><td style="padding:6px 28px;font-size:15px;line-height:1.6;color:#33415c">${paras.map((p) => `<p style="margin:0 0 12px">${inline(p, vars, linkWrap).replace(/\n/g, "<br>")}</p>`).join("")}</td></tr>`);
      text.push(mergeText(b.text, vars).replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, "$1 ($2)"), "");
    }
    if (b.type === "button") {
      const url = mergeText(b.url, vars);
      rows.push(`<tr><td style="padding:12px 28px"><a href="${esc(linkWrap(url))}" style="background:${esc(brandColor)};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;display:inline-block;font-weight:bold;font-size:15px">${esc(mergeText(b.label, vars))}</a></td></tr>`);
      text.push(`${mergeText(b.label, vars)}: ${url}`, "");
    }
    if (b.type === "image") {
      const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="504" style="max-width:100%;height:auto;display:block;border:0">`;
      rows.push(`<tr><td style="padding:8px 28px">${b.href ? `<a href="${esc(linkWrap(b.href))}">${img}</a>` : img}</td></tr>`);
      if (b.alt) text.push(`[${b.alt}]`, "");
    }
    if (b.type === "divider") { rows.push(`<tr><td style="padding:12px 28px"><hr style="border:0;border-top:1px solid #e3e6eb;margin:0"></td></tr>`); text.push("----", ""); }
    if (b.type === "spacer") rows.push(`<tr><td style="height:${b.height}px;line-height:${b.height}px;font-size:0">&nbsp;</td></tr>`);
    if (b.type === "columns") {
      rows.push(`<tr><td style="padding:6px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" width="50%" style="padding-right:10px;font-size:14px;line-height:1.6;color:#33415c">${inline(b.left || "", vars, linkWrap).replace(/\n/g, "<br>")}</td><td valign="top" width="50%" style="padding-left:10px;font-size:14px;line-height:1.6;color:#33415c">${inline(b.right || "", vars, linkWrap).replace(/\n/g, "<br>")}</td></tr></table></td></tr>`);
      text.push(mergeText(b.left || "", vars), mergeText(b.right || "", vars), "");
    }
  }
  const unsub = footer.unsubscribeUrl;
  const footerHtml = `<p style="margin:0 0 6px">${esc(footer.businessName || "")}${footer.postalAddress ? ` · ${esc(footer.postalAddress)}` : ""}</p>${footer.reason ? `<p style="margin:0 0 6px">${esc(footer.reason)}</p>` : ""}${unsub ? `<p style="margin:0"><a href="${esc(unsub)}" style="color:#6b7280">Unsubscribe</a></p>` : ""}`;
  const pre = mergeText(preheader, vars);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif">
${pre ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #e3e6eb;border-radius:10px" cellpadding="0" cellspacing="0">
<tr><td style="height:6px;background:${esc(brandColor)};border-radius:10px 10px 0 0;font-size:0">&nbsp;</td></tr>
<tr><td style="height:16px;font-size:0">&nbsp;</td></tr>${rows.join("")}<tr><td style="height:20px;font-size:0">&nbsp;</td></tr></table>
<table role="presentation" width="100%" style="max-width:560px" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 8px;font-size:12px;line-height:1.5;color:#6b7280;text-align:center">${footerHtml}</td></tr></table>
</td></tr></table>${openPixelUrl ? `<img src="${esc(openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ""}</body></html>`;
  const textOut = [...text, "--", `${footer.businessName || ""}${footer.postalAddress ? `, ${footer.postalAddress}` : ""}`, ...(unsub ? [`Unsubscribe: ${unsub}`] : [])].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { html, text: textOut };
}

// ------------------------------------------------------- starter templates

export const STARTER_TEMPLATES = [
  { key: "newsletter", useCase: "newsletter", name: "Monthly newsletter", subject: "{{business_name}} news for you, {{first_name|there}}", preheader: "What's new this month", blocks: [
    { type: "heading", level: 1, text: "This month at {{business_name}}" },
    { type: "text", text: "Hi {{first_name|there}},\n\nHere's a short round-up of what we've been working on and what's coming next." },
    { type: "heading", level: 2, text: "Highlights" },
    { type: "text", text: "**One:** a sentence about your first update.\n\n**Two:** a sentence about your second update." },
    { type: "button", label: "Read more", url: "https://example.com" },
    { type: "divider" },
    { type: "text", text: "Questions? Just reply to this email." },
  ] },
  { key: "promotional", useCase: "promotional", name: "Promotional offer", subject: "{{first_name|Hi}}, an offer for you", preheader: "For a limited time", blocks: [
    { type: "heading", level: 1, text: "A special offer for {{company|you}}" },
    { type: "text", text: "Hi {{first_name|there}},\n\nFor a limited time, describe the offer here: what it is, who it's for and when it ends." },
    { type: "button", label: "Claim the offer", url: "https://example.com" },
    { type: "text", text: "Offer ends on DATE. Terms apply." },
  ] },
  { key: "reengagement", useCase: "reengagement", name: "We miss you (re-engagement)", subject: "It's been a while, {{first_name|there}}", preheader: "Here's what you've missed", blocks: [
    { type: "heading", level: 1, text: "We haven't heard from you in a while" },
    { type: "text", text: "Hi {{first_name|there}},\n\nA lot has changed since we last spoke. If now's a good time, book a short call and we'll catch up." },
    { type: "button", label: "Book a time", url: "{{booking_url}}" },
    { type: "text", text: "Not interested any more? You can unsubscribe below and we won't email again." },
  ] },
  { key: "product_update", useCase: "product_update", name: "Product update", subject: "What's new at {{business_name}}", preheader: "New features and improvements", blocks: [
    { type: "heading", level: 1, text: "What's new" },
    { type: "text", text: "Hi {{first_name|there}},\n\nWe've shipped some improvements we think you'll like." },
    { type: "columns", left: "**New:** describe the main feature.", right: "**Improved:** describe what got better." },
    { type: "button", label: "See what's new", url: "https://example.com" },
  ] },
  { key: "event_invitation", useCase: "event_invitation", name: "Event invitation", subject: "You're invited, {{first_name|there}}", preheader: "Save the date", blocks: [
    { type: "heading", level: 1, text: "You're invited" },
    { type: "text", text: "Hi {{first_name|there}},\n\nJoin us for EVENT NAME on DATE at TIME.\n\n**Where:** location or online link\n**Agenda:** one line about what attendees will get." },
    { type: "button", label: "Reserve your place", url: "https://example.com" },
  ] },
];

export const USE_CASES = { newsletter: "Newsletter", promotional: "Promotional email", reengagement: "Re-engagement (inactive users)", product_update: "Product update", event_invitation: "Event invitation", other: "Other" };

function templateView(t) { const { orgId, kind, ...rest } = t; return { ...rest, id: String(t._id), starter: false }; }

export async function listTemplates(orgId) {
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  const own = await marketing.find({ orgId: toObjectId(orgId), kind: "template", archived: { $ne: true } }).sort({ updatedAt: -1 }).limit(200).toArray();
  return { templates: [...STARTER_TEMPLATES.map((t) => ({ ...t, id: `starter:${t.key}`, starter: true })), ...own.map(templateView)], mergeFields: MERGE_FIELDS, useCases: USE_CASES };
}

export async function resolveTemplate(orgId, templateId) {
  if (String(templateId || "").startsWith("starter:")) return STARTER_TEMPLATES.find((t) => `starter:${t.key}` === templateId) || null;
  const { marketing } = await engagementCollections();
  return oid(templateId) ? marketing.findOne({ _id: oid(templateId), orgId: toObjectId(orgId), kind: "template" }) : null;
}

export async function saveTemplate({ orgId, membership, actorEmail, templateId, name, useCase, subject, preheader, blocks, archived }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role to save templates.", 403);
  const { marketing } = await engagementCollections();
  if (templateId && archived !== undefined) {
    const r = oid(templateId) && await marketing.updateOne({ _id: oid(templateId), orgId: toObjectId(orgId), kind: "template" }, { $set: { archived: archived === true, updatedAt: nowIso() } });
    return r?.matchedCount ? { ok: true } : fail("Template not found.", 404);
  }
  const n = clean(name, 100); if (!n) return fail("Name the template.");
  const v = validateBlocks(blocks); if (v.error) return fail(v.error);
  const doc = { name: n, useCase: USE_CASES[useCase] ? useCase : "other", subject: clean(subject, 200), preheader: clean(preheader, 200), blocks: v.blocks, updatedAt: nowIso(), updatedBy: actorEmail };
  if (templateId) {
    const r = oid(templateId) && await marketing.updateOne({ _id: oid(templateId), orgId: toObjectId(orgId), kind: "template" }, { $set: doc });
    if (!r?.matchedCount) return fail("Template not found.", 404);
    return { template: templateView(await marketing.findOne({ _id: oid(templateId) })) };
  }
  const full = { orgId: toObjectId(orgId), kind: "template", ...doc, archived: false, createdBy: actorEmail, createdAt: nowIso() };
  const r = await marketing.insertOne(full);
  return { template: templateView({ ...full, _id: r.insertedId }) };
}
