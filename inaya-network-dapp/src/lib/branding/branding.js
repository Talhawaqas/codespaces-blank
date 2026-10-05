// src/lib/branding/branding.js
//
// Organization branding (Competitive Expansion SOW workstream R, BRAND-001): logo, favicon, login background, accent colour, portal title, support
// URL, legal text (terms, privacy), email header/footer, and a custom domain record. Applied to secure share links, data-room visitor pages,
// file-request pages and emails.
//
// SANITIZATION: nothing here is ever rendered as HTML. Text is control-character-stripped and length-capped and shown as text; colours must be #rrggbb;
// URLs must be https; images must be PNG, JPEG or WebP (verified by their magic bytes, size-capped; SVG is refused because it can carry script). Custom
// HTML cannot escape the trusted UI. Branding is stored per organization and only ever resolved for the organization that owns the token or room.
// CUSTOM DOMAIN: Inaya verifies DNS ownership (a TXT record). Attaching the domain to the hosting platform (certificate, routing) is a platform step
// Inaya's own deployment does not automate, so a verified domain is reported as such and "routing" stays NOT_CONFIGURED until an operator completes it.
// Collection: org_branding.

import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ObjectId } from "mongodb";

export class BrandingError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new BrandingError(status, message); };
const nowIso = () => new Date().toISOString();
const text = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[<>]/g, "").trim().slice(0, max);
export const LIMITS = { logo: 150_000, favicon: 32_000, background: 300_000, legal: 20_000 };
const HEX = /^#[0-9a-fA-F]{6}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Verify a data: URL is a real PNG, JPEG or WebP within the size cap. Returns the normalized data URL. */
export function checkImage(dataUrl, max, label) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || "")); if (!m) fail(400, `${label} must be a PNG, JPEG or WebP image.`);
  const buf = Buffer.from(m[2], "base64"); if (!buf.length || buf.length > max) fail(400, `${label} must be ${Math.round(max / 1000)} KB or smaller.`);
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; const webp = buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  const ok = (m[1] === "image/png" && png) || (m[1] === "image/jpeg" && jpg) || (m[1] === "image/webp" && webp); if (!ok) fail(400, `${label} is not a valid ${m[1].split("/")[1].toUpperCase()} file.`);
  return `data:${m[1]};base64,${m[2]}`;
}
export function validateBranding(input, { partial = true } = {}) {
  const v = {}; const has = (k) => input[k] !== undefined;
  if (has("portalTitle")) v.portalTitle = text(input.portalTitle, 60) || null;
  if (has("accent")) { if (input.accent && !HEX.test(input.accent)) fail(400, "The accent colour must look like #1a73e8."); v.accent = input.accent || null; }
  if (has("supportUrl")) { if (input.supportUrl) { let u; try { u = new URL(input.supportUrl); } catch { fail(400, "The support URL is not valid."); } if (u.protocol !== "https:" || u.username || u.password) fail(400, "The support URL must be a plain https address."); v.supportUrl = u.href.slice(0, 300); } else v.supportUrl = null; }
  if (has("logo")) v.logo = input.logo ? checkImage(input.logo, LIMITS.logo, "The logo") : null;
  if (has("favicon")) v.favicon = input.favicon ? checkImage(input.favicon, LIMITS.favicon, "The favicon") : null;
  if (has("loginBackground")) v.loginBackground = input.loginBackground ? checkImage(input.loginBackground, LIMITS.background, "The background") : null;
  if (has("legal")) { const l = input.legal || {}; v.legal = { terms: text(l.terms, LIMITS.legal) || null, privacy: text(l.privacy, LIMITS.legal) || null }; }
  if (has("email")) { const e = input.email || {}; if (e.headerColor && !HEX.test(e.headerColor)) fail(400, "The email header colour must look like #1a73e8."); v.email = { headerColor: e.headerColor || null, footerText: text(e.footerText, 500) || null }; }
  return v;
}

async function col() { const c = await getOrgCollections(); const b = c.db.collection("org_branding"); await b.createIndex({ orgId: 1 }, { unique: true }).catch(() => {}); return b; }
const adminView = (b) => ({ portalTitle: b?.portalTitle || null, accent: b?.accent || null, supportUrl: b?.supportUrl || null, logo: b?.logo || null, favicon: b?.favicon || null, loginBackground: b?.loginBackground || null, legal: b?.legal || { terms: null, privacy: null }, email: b?.email || { headerColor: null, footerText: null }, customDomain: b?.customDomain || null, updatedAt: b?.updatedAt || null });

export async function getBranding({ orgId, membership }) { if (!canManageOrg(membership)) fail(403, "Only an owner or admin can see branding settings."); return adminView(await (await col()).findOne({ orgId: toObjectId(orgId) })); }
export async function setBranding({ orgId, membership, actorEmail, input }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can change branding."); const v = validateBranding(input); const b = await col();
  await b.updateOne({ orgId: toObjectId(orgId) }, { $set: { ...v, updatedAt: nowIso(), updatedBy: actorEmail } }, { upsert: true });
  await logOrgActivity({ orgId, recordType: "BRANDING", recordId: new ObjectId(), actorEmail, action: "BRANDING_UPDATED", previousState: null, newState: null, metadata: { fields: Object.keys(v) } }).catch(() => {}); return adminView(await b.findOne({ orgId: toObjectId(orgId) }));
}
/** What an external visitor may see of an organization's branding. Safe to return from public endpoints. */
export async function publicBranding(orgId) {
  try {
    const b = await (await col()).findOne({ orgId: toObjectId(orgId) }); if (!b) return null;
    return { portalTitle: b.portalTitle || null, accent: b.accent || null, logo: b.logo || null, favicon: b.favicon || null, loginBackground: b.loginBackground || null, supportUrl: b.supportUrl || null, terms: b.legal?.terms || null, privacy: b.legal?.privacy || null, footerText: b.email?.footerText || null };
  } catch { return null; }
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** A branded email: header colour, optional logo link, text lines (escaped), one optional button, footer. Returns { html, text }. */
export async function brandedEmail({ orgId, orgName = "Inaya", title, lines = [], ctaUrl = null, ctaLabel = "Open" }) {
  const b = (await publicBranding(orgId)) || {}; const ew = await (await col()).findOne({ orgId: toObjectId(orgId) }).catch(() => null); const color = ew?.email?.headerColor || b.accent || "#0b1220"; const name = esc(b.portalTitle || orgName);
  let cta = ""; if (ctaUrl) { try { const u = new URL(ctaUrl); if (u.protocol === "https:" || u.protocol === "http:") cta = `<p style="margin:20px 0"><a href="${esc(u.href)}" style="background:${esc(color)};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(ctaLabel)}</a></p>`; } catch { /* no button */ } }
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden"><div style="background:${esc(color)};color:#fff;padding:14px 20px;font-weight:700">${name}</div><div style="padding:20px;color:#111827"><h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${lines.map((l) => `<p style="margin:8px 0">${esc(l)}</p>`).join("")}${cta}</div>${b.footerText ? `<div style="padding:12px 20px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">${esc(b.footerText)}</div>` : ""}</div>`;
  return { html, text: [title, ...lines, ctaUrl ? `${ctaLabel}: ${ctaUrl}` : "", b.footerText || ""].filter(Boolean).join("\n\n") };
}

// ----------------------------------------------------------------------------------------------------------- custom domain
export async function setCustomDomain({ orgId, membership, actorEmail, domain }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can set a custom domain."); const d = String(domain || "").trim().toLowerCase().replace(/\.$/, "");
  if (!HOST.test(d) || d.endsWith(".inaya.network") || /(^|\.)localhost$/.test(d)) fail(400, "Enter a domain you own, such as files.example.com.");
  const b = await col(); const other = await b.findOne({ "customDomain.domain": d, orgId: { $ne: toObjectId(orgId) } }); if (other) fail(409, "That domain is already in use by another organization.");
  const token = `inaya-verify=${randomBytes(16).toString("hex")}`; const cd = { domain: d, txtName: `_inaya-verify.${d}`, txtValue: token, status: "PENDING_DNS", routing: "NOT_CONFIGURED", requestedAt: nowIso(), note: "Add the TXT record, then check it. Routing the domain to Inaya also needs an operator to attach it to the hosting platform." };
  await b.updateOne({ orgId: toObjectId(orgId) }, { $set: { customDomain: cd, updatedAt: nowIso() } }, { upsert: true }); await logOrgActivity({ orgId, recordType: "BRANDING", recordId: new ObjectId(), actorEmail, action: "DOMAIN_REQUESTED", previousState: null, newState: null, metadata: { domain: d } }).catch(() => {}); return cd;
}
export async function verifyCustomDomain({ orgId, membership, actorEmail, resolver = dns.resolveTxt }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can verify a custom domain."); const b = await col(); const row = await b.findOne({ orgId: toObjectId(orgId) }); const cd = row?.customDomain; if (!cd) fail(404, "No custom domain has been requested.");
  let found = []; try { found = (await resolver(cd.txtName)).map((r) => r.join("")); } catch { found = []; }
  const verified = found.includes(cd.txtValue); const next = { ...cd, status: verified ? "VERIFIED_DNS" : "PENDING_DNS", checkedAt: nowIso(), note: verified ? "DNS ownership is verified. Routing the domain to Inaya is still a platform step (NOT_CONFIGURED until an operator attaches it)." : "The TXT record was not found yet. DNS changes can take a while to appear." };
  await b.updateOne({ orgId: toObjectId(orgId) }, { $set: { customDomain: next } }); if (verified) await logOrgActivity({ orgId, recordType: "BRANDING", recordId: new ObjectId(), actorEmail, action: "DOMAIN_VERIFIED", previousState: null, newState: null, metadata: { domain: cd.domain } }).catch(() => {}); return next;
}
