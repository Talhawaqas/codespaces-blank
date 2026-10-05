// src/lib/governance/enforce.js
//
// Enforcement points for governance policy that is not DLP rules or upload checks: sharing limits (external_sharing, public_links,
// download_limits, external_domain). Called by the share code AFTER the normal permission check; it can only refuse, never grant.
// Most restrictive value wins when several policies apply.

import { effectivePolicies, GovError } from "./policies.js";
import { assertDlp } from "./dlp.js";

const domainOf = (e) => String(e || "").toLowerCase().split("@")[1] || "";
const inList = (list, d) => list.some((x) => { const p = String(x).toLowerCase().replace(/^\*\./, ""); return d === p || d.endsWith("." + p); });

/** Before a share link is created. `options` is the validated link option object (password, maxUses, maxDownloads, domainAllow...). */
export async function enforceShareCreation({ orgId, actorEmail, role, documentId, expiresAt, options = {}, classification = null, ip = null }) {
  const ctx = { email: actorEmail, role };
  const [ext, pub, dl, dom] = await Promise.all(["external_sharing", "public_links", "download_limits", "external_domain"].map((type) => effectivePolicies({ orgId, type, ctx })));
  const refuse = (m) => { throw new GovError(403, m, { code: "POLICY_BLOCKED" }); };
  if (ext.some((p) => p.config.allowed === false)) refuse("Your organization does not allow sharing outside the company.");
  if (pub.some((p) => p.config.allowed === false)) refuse("Your organization does not allow public links.");
  const hours = Math.min(...[...ext, ...pub].map((p) => p.config.maxExpiryHours).filter((h) => h != null), Infinity);
  const exp = expiresAt ? new Date(expiresAt).getTime() : Infinity; const lifeHours = (exp - Date.now()) / 3600_000;
  if (hours !== Infinity && lifeHours > hours) refuse(`Links in your organization can last at most ${hours} hours.`);
  if ([...ext, ...pub].some((p) => p.config.requirePassword) && !options.password) refuse("Your organization requires a password on external links.");
  const cap = Math.min(...dl.map((p) => p.config.maxPerShare).filter((n) => n != null), Infinity);
  if (cap !== Infinity && (!options.maxDownloads || options.maxDownloads > cap)) refuse(`Links must allow at most ${cap} downloads.`);
  const allowed = dom.flatMap((p) => p.config.allowedDomains || []); const blocked = dom.flatMap((p) => p.config.blockedDomains || []);
  const wanted = (options.domainAllow || []).map((d) => String(d).toLowerCase().replace(/^@/, ""));
  if (allowed.length && (!wanted.length || wanted.some((d) => !inList(allowed, d)))) refuse(`External links must be limited to these domains: ${allowed.join(", ")}.`);
  if (wanted.some((d) => inList(blocked, d))) refuse("One of those domains is not allowed by your organization.");
  await assertDlp({ orgId, ctx: { email: actorEmail, role, ip, action: "share_create", resourceType: "document", resourceId: documentId, classification, shareType: "link", destinationType: wanted.length ? "external" : "public_link", destinationDomain: wanted[0] || null, link: { passwordProtected: !!options.password, expiresInHours: exp === Infinity ? null : lifeHours, maxUses: options.maxUses || null }, source: "shares" } });
}

/** When someone opens a share link or fetches its content. `email` may be null for an anonymous visitor. */
export function dlpForShareAccess({ orgId, share, action, ip, email, classification = null }) {
  return assertDlp({ orgId, ctx: { email: email || "anonymous@external", role: "external", ip, action, resourceType: "document", resourceId: String(share.documentId), classification, shareType: "link", destinationType: "external", destinationDomain: domainOf(email) || null, downloadCount: share.downloadCount || 0, link: { passwordProtected: !!share.passwordHash, maxUses: share.maxUses || null }, source: "shares" } });
}
