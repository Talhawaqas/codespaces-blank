// src/lib/licensing/gate.js -- the central license gate (SOW section 9).
//
// Called from requireMembership (src/lib/orgs.js), which nearly every Business OS API uses, and from the
// other ways company data is reached (S3/Azure keys, share links, data rooms, the customer portal, file requests,
// the public API, scheduled jobs): see docs/licensing/BUSINESS_WORKSPACE_LICENSE_PERMISSION_MATRIX.md for the
// route-by-route list. It is an ADDITIONAL gate: it never grants anything the existing role, department or record
// permissions would refuse.
//
// When a company's license is restricted (suspended, cancelled after its end date, expired), only these stay open:
//   every member:      the session (sign-in, company list), the license status notice
//   Owner / Admin:     Billing, the license page, company data export (ZIP), and read-only document download
//                      (founder decision 11: Documents files are encrypted with the company's passkey, which the
//                      server never holds, so the owner downloads them in the browser)
// Help & Support (/api/help/*) does not use requireMembership, so it is always reachable.

import { effectiveState } from "./state.js";
import { enforcementEnabled } from "./config.js";

const CACHE_MS = 15 * 1000;
const cache = new Map(); // orgId -> { at, lic }

/** Drops the cached license so a change (suspend, reactivate, payment) applies on this server at once. */
export function invalidateLicenseCache(orgId) { cache.delete(String(orgId)); }

async function loadLicense(orgId) {
  const key = String(orgId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.lic;
  const { connectToDatabase } = await import("../mongodb.js");
  const { ObjectId } = await import("mongodb");
  const { db } = await connectToDatabase();
  let oid; try { oid = new ObjectId(String(orgId)); } catch { return null; }
  const lic = await db.collection("org_subscriptions").findOne({ orgId: oid }, { projection: { licenseId: 1, licenseStatus: 1, paymentDueAt: 1, graceEndsAt: 1, cancelEffectiveAt: 1, overrideUntil: 1, suspendedReason: 1 } });
  const value = lic?.licenseId ? lic : null;
  cache.set(key, { at: Date.now(), lic: value });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return value;
}

/** The effective license state of a company for access decisions (cached for 15 s per server). */
export async function companyAccess(orgId, now = new Date()) {
  if (!enforcementEnabled()) return { state: "unenforced", access: "normal" };
  return effectiveState(await loadLicense(orgId), now);
}

// Paths still open when the license is restricted. [pattern, methods, who]
const OPEN_WHEN_RESTRICTED = [
  [/^\/api\/orgs\/session(\/|$)/, null, "member"],
  [/^\/api\/orgs\/license\/status$/, ["GET"], "member"],
  [/^\/api\/orgs\/license(\/|$)/, null, "manager"],
  [/^\/api\/orgs\/billing(\/|$)/, null, "manager"],
  [/^\/api\/orgs\/export-zip$/, ["GET"], "manager"],
  [/^\/api\/orgs\/exports(\/|$)/, null, "manager"],
  [/^\/api\/orgs\/documents\/[^/]+\/retrieve$/, ["GET"], "manager"],
];

export function isOpenWhenRestricted(pathname, method, isManager) {
  return OPEN_WHEN_RESTRICTED.some(([re, methods, who]) => re.test(pathname) && (!methods || methods.includes(method)) && (who === "member" || isManager));
}

export const RESTRICTED_CODE = "LICENSE_RESTRICTED";

function restrictedMessage(state, isManager) {
  const what = state === "cancelled" ? "cancelled" : state === "expired" ? "expired" : "suspended";
  return isManager
    ? `Your company's Business OS license is ${what}. Billing, Help & Support and your company data export are still available.`
    : `Your company's Business OS access is paused. Please contact your company's owner or admin.`;
}

/**
 * The gate. Returns null (allowed) or { error, status: 403, code } for a request that a restricted license does not
 * permit. `req` is the incoming Request; `isManager` is the member's existing owner/admin right.
 */
export async function licenseGate(req, orgId, { isManager = false, now = new Date() } = {}) {
  const access = await companyAccess(orgId, now);
  if (access.access !== "restricted") return null;
  let pathname = ""; let method = "GET";
  try { pathname = new URL(req.url).pathname; method = String(req.method || "GET").toUpperCase(); } catch { /* not an HTTP request: treat as a normal API call */ }
  if (isOpenWhenRestricted(pathname, method, isManager)) return null;
  noteDenied(orgId, access.state);
  return { error: restrictedMessage(access.state, isManager), status: 403, code: RESTRICTED_CODE, licenseState: access.state };
}

/** For callers that are not an HTTP route of the Workspace (S3 keys, share links, jobs): is normal use allowed? */
export async function companyMayOperate(orgId, now = new Date()) {
  if (!orgId) return true;
  const access = await companyAccess(orgId, now);
  if (access.access === "restricted") { noteDenied(orgId, access.state); return false; }
  return true;
}

let denied = 0;
function noteDenied(orgId, state) {
  denied += 1;
  import("../metrics/metrics.js").then((m) => m.metric?.("license.entitlement_denied", { orgId: String(orgId), label: state })).catch(() => {});
}
export const deniedCount = () => denied;
