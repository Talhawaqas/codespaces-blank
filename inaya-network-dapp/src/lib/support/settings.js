// src/lib/support/settings.js
//
// SOW §50: support configuration (one document per organization). Everything a workspace can tune lives
// here; nothing about it is hard-coded in the ticket engine.

import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { PRIORITIES, fail, nowIso } from "./common.js";
import { isValidTimezone } from "../workflows/schedule.js";
import { localTestHostsAllowed } from "../workflows/http.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { randomBytes } from "node:crypto";

export const DEFAULT_TICKET_TYPES = ["Technical Support", "Billing", "Account", "Access", "Security", "Storage", "Drive", "API", "Integration", "Migration", "Enterprise Support", "Feature Request", "Incident", "Other"];
export const DEFAULT_CATEGORIES = ["General", "Billing", "Account", "Access", "Security", "Storage", "API", "Integration", "Migration", "Other"];
export const BLOCKED_EXTENSIONS = ["exe", "dll", "bat", "cmd", "com", "scr", "msi", "ps1", "vbs", "vbe", "js", "jse", "jar", "app", "apk", "sh", "reg", "lnk", "hta", "cpl", "wsf", "pif", "iso"];

export const DEFAULT_SETTINGS = {
  portalEnabled: false, portalSlug: null, portalName: null, welcomeText: "How can we help you today?",
  ticketPrefix: "TKT",
  ticketTypes: DEFAULT_TICKET_TYPES, categories: DEFAULT_CATEGORIES, priorities: PRIORITIES,
  customerSelectableTypes: ["Technical Support", "Billing", "Account", "Access", "Security", "Storage", "Drive", "API", "Integration", "Migration", "Other"],
  lifecycle: { pauseStatuses: ["WAITING_FOR_CUSTOMER", "WAITING_FOR_THIRD_PARTY"], extraTransitions: {} },
  businessHours: { timezone: "UTC", mode: "business", weekly: { 1: [["09:00", "17:00"]], 2: [["09:00", "17:00"]], 3: [["09:00", "17:00"]], 4: [["09:00", "17:00"]], 5: [["09:00", "17:00"]] }, holidays: [] },
  sla: { atRiskPct: 80 },
  signup: "contacts_only", // "contacts_only": only people already in the CRM can sign in; "open": anyone may (a CRM lead is created)
  fallbackQueueId: null,
  reopenWindowDays: 14, autoCloseSolvedAfterDays: 7,
  email: { supportAddress: null, requireAuthResults: true, unknownSenders: "quarantine", maxBytes: 5 * 1024 * 1024 },
  ai: { triageEnabled: true, chatEnabled: true, autoApply: { category: true, queue: true, priority: false }, minConfidence: 0.7, chatMinConfidence: 0.55 },
  kb: { enabled: true }, ideas: { enabled: true, votingEnabled: false }, csat: { enabled: true },
  retention: { ticketDays: 1095, chatDays: 90, attachmentDays: 1095, ideaDays: 1095 },
  rate: { ticketsPerHour: 10, repliesPerHour: 30, chatPerHour: 60, apiPerMinute: 120, loginPerHour: 8 },
  attachments: { maxBytes: 25 * 1024 * 1024, maxPerMessage: 5 },
  scan: { mode: "static" }, // "static": built-in inspection (+ any engine the platform has configured); "engine_required": refuse files when no antivirus engine answers
  sso: { enabled: false, issuer: "", clientId: "", label: "Company sign-in", allowedDomains: [], requireVerifiedEmail: true },
  customerTiers: ["STANDARD", "PRIORITY", "ENTERPRISE"],
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(isObj(over) ? over : {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export async function getSettings(orgId) {
  await ensureSupportIndexes();
  const { supportSettings } = await getSupportCollections();
  const doc = await supportSettings.findOne({ orgId: toObjectId(orgId) });
  const merged = merge(DEFAULT_SETTINGS, doc?.settings || {});
  merged.portalSlug = doc?.portalSlug || null;
  merged.portalEnabled = !!doc?.portalEnabled;
  merged._hasInboundSecret = !!doc?.inboundSecretEncrypted;
  merged._hasSsoSecret = !!doc?.ssoClientSecretEncrypted;
  return merged;
}

/** Public projection: never includes secrets. */
export function publicSettings(s) { const { _hasInboundSecret, _hasSsoSecret, ...rest } = s; return { ...rest, email: { ...rest.email, inboundSecretSet: !!_hasInboundSecret }, sso: { ...rest.sso, clientSecretSet: !!_hasSsoSecret } }; }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/;

/** Validates and saves a partial settings patch. Returns the new settings or { error }. */
export async function updateSettings({ orgId, patch, actorEmail }) {
  await ensureSupportIndexes();
  const { supportSettings } = await getSupportCollections();
  const cur = await getSettings(orgId);
  const p = isObj(patch) ? patch : {};
  const errors = [];
  const next = merge(cur, p);
  const top = {};
  if (p.portalSlug !== undefined) { if (p.portalSlug !== null && !SLUG_RE.test(String(p.portalSlug))) errors.push("portalSlug must be 4–40 characters: lowercase letters, numbers and hyphens."); else top.portalSlug = p.portalSlug ? String(p.portalSlug) : null; }
  if (p.portalEnabled !== undefined) top.portalEnabled = !!p.portalEnabled;
  if (p.ticketPrefix !== undefined && !/^[A-Z]{2,8}$/.test(String(p.ticketPrefix))) errors.push("ticketPrefix must be 2–8 capital letters.");
  for (const k of ["ticketTypes", "categories", "customerSelectableTypes", "customerTiers"]) if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].length && p[k].length <= 60 && p[k].every((x) => typeof x === "string" && x.length >= 1 && x.length <= 60))) errors.push(`${k} must be a list of 1–60 short names.`);
  if (p.businessHours) {
    const bh = next.businessHours;
    if (!isValidTimezone(bh.timezone)) errors.push("businessHours.timezone is not a valid timezone.");
    if (!["business", "24x7"].includes(bh.mode)) errors.push("businessHours.mode must be business or 24x7.");
    for (const [d, spans] of Object.entries(bh.weekly || {})) {
      if (!/^[0-6]$/.test(d) || !Array.isArray(spans)) { errors.push("businessHours.weekly needs days 0–6 with time spans."); break; }
      for (const s of spans) if (!Array.isArray(s) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s[0]) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s[1]) || s[0] >= s[1]) errors.push(`businessHours day ${d}: each span needs a start before its end (HH:MM).`);
    }
    for (const h of bh.holidays || []) if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) errors.push("businessHours.holidays must be YYYY-MM-DD dates.");
  }
  if (next.sla.atRiskPct < 1 || next.sla.atRiskPct > 99) errors.push("sla.atRiskPct must be 1–99.");
  if (!["contacts_only", "open"].includes(next.signup)) errors.push("signup must be contacts_only or open.");
  if (!["quarantine", "create_unverified"].includes(next.email.unknownSenders)) errors.push("email.unknownSenders must be quarantine or create_unverified.");
  for (const [k, v] of Object.entries(next.rate)) if (!Number.isFinite(v) || v < 1 || v > 100000) errors.push(`rate.${k} must be between 1 and 100000.`);
  if (!(next.attachments.maxBytes >= 1024 && next.attachments.maxBytes <= 25 * 1024 * 1024)) errors.push("attachments.maxBytes must be between 1 KB and 25 MB.");
  if (!["static", "engine_required"].includes(next.scan.mode)) errors.push("scan.mode must be static or engine_required.");
  if (p.sso) {
    const so = next.sso;
    if (so.enabled && !(typeof so.issuer === "string" && /^https:\/\//i.test(so.issuer) || (so.issuer && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(so.issuer) && localTestHostsAllowed()))) errors.push("sso.issuer must be the https address of your identity provider.");
    if (so.enabled && !so.clientId) errors.push("sso.clientId is required to enable single sign-on.");
    if (!Array.isArray(so.allowedDomains) || so.allowedDomains.length > 50 || so.allowedDomains.some((d) => typeof d !== "string" || !/^[a-z0-9.-]{3,100}$/i.test(d))) errors.push("sso.allowedDomains must be a list of email domains.");
    if (typeof so.label !== "string" || so.label.length < 2 || so.label.length > 40) errors.push("sso.label must be 2-40 characters.");
  }
  const transitions = next.lifecycle.extraTransitions;
  if (!isObj(transitions)) errors.push("lifecycle.extraTransitions must be an object."); else for (const [from, tos] of Object.entries(transitions)) if (!Array.isArray(tos)) errors.push("lifecycle.extraTransitions values must be lists.");
  if (errors.length) return fail(errors[0], 400, { errors });
  // secrets and portal fields are managed separately; strip them from the stored `settings` blob
  const { portalSlug, portalEnabled, _hasInboundSecret, _hasSsoSecret, ...store } = next;
  try {
    await supportSettings.updateOne({ orgId: toObjectId(orgId) }, { $set: { settings: store, ...top, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  } catch (err) { if (err?.code === 11000) return fail("That portal address is already taken.", 409); throw err; }
  return { settings: await getSettings(orgId) };
}

// ------------------------------------------------------------ inbound email secret
/** Creates (or rotates) the shared secret used to sign inbound-email deliveries. Shown once. */
export async function rotateInboundSecret({ orgId, actorEmail }) {
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  await ensureSupportIndexes();
  const { supportSettings } = await getSupportCollections();
  const secret = `inb_${randomBytes(24).toString("hex")}`;
  await supportSettings.updateOne({ orgId: toObjectId(orgId) }, { $set: { inboundSecretEncrypted: encryptIntegrationSecret(secret), inboundSecretAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { createdAt: nowIso(), settings: {} } }, { upsert: true });
  return { inboundSecret: secret, note: "Save this secret now: it is shown once." };
}

export async function getInboundSecret(orgId) {
  const { supportSettings } = await getSupportCollections();
  const doc = await supportSettings.findOne({ orgId: toObjectId(orgId) });
  if (!doc?.inboundSecretEncrypted) return null;
  try { return decryptIntegrationSecret(doc.inboundSecretEncrypted); } catch { return null; }
}

/** Resolves a portal slug to its organization (enabled portals only). */
export async function orgBySlug(slug) {
  await ensureSupportIndexes();
  const { supportSettings } = await getSupportCollections();
  if (!SLUG_RE.test(String(slug || ""))) return null;
  const doc = await supportSettings.findOne({ portalSlug: String(slug), portalEnabled: true });
  return doc ? { orgId: doc.orgId, settings: merge(DEFAULT_SETTINGS, doc.settings || {}), portalSlug: doc.portalSlug } : null;
}

// ------------------------------------------------------------ single sign-on client secret
export async function setSsoClientSecret({ orgId, secret, actorEmail }) {
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  if (typeof secret !== "string" || secret.length < 8 || secret.length > 500) return fail("The client secret looks invalid.");
  await ensureSupportIndexes();
  const { supportSettings } = await getSupportCollections();
  await supportSettings.updateOne({ orgId: toObjectId(orgId) }, { $set: { ssoClientSecretEncrypted: encryptIntegrationSecret(secret), ssoClientSecretAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { createdAt: nowIso(), settings: {} } }, { upsert: true });
  return { saved: true };
}
export async function getSsoClientSecret(orgId) {
  const { supportSettings } = await getSupportCollections();
  const doc = await supportSettings.findOne({ orgId: toObjectId(orgId) });
  if (!doc?.ssoClientSecretEncrypted) return null;
  try { return decryptIntegrationSecret(doc.ssoClientSecretEncrypted); } catch { return null; }
}

/** Creates the org's inbound-email signing secret if it has none (used to sign reply addresses); never returns it. */
export async function ensureInboundSecret(orgId) {
  if (!isIntegrationCryptoConfigured()) return false;
  const { supportSettings } = await getSupportCollections();
  const doc = await supportSettings.findOne({ orgId: toObjectId(orgId) }, { projection: { inboundSecretEncrypted: 1 } });
  if (doc?.inboundSecretEncrypted) return true;
  await supportSettings.updateOne({ orgId: toObjectId(orgId), inboundSecretEncrypted: { $exists: false } }, { $set: { inboundSecretEncrypted: encryptIntegrationSecret(`inb_${randomBytes(24).toString("hex")}`), inboundSecretAt: nowIso() }, $setOnInsert: { createdAt: nowIso(), settings: {} } }, { upsert: true }).catch(() => {});
  return true;
}
