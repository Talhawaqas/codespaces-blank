// scripts/sqa/license-route-coverage.mjs -- License Manager SOW 9.3: every API route, classified by how it reaches
// company data, and whether the company-license gate covers it.
//
//   node scripts/sqa/license-route-coverage.mjs            -> summary + the routes that need a decision
//   node scripts/sqa/license-route-coverage.mjs --json     -> machine-readable list (used by test/license-route-coverage.test.mjs)
//
// Classes:
//   member          uses requireMembership -> gated centrally (src/lib/licensing/gate.js)
//   license_gated   reaches company data another way and calls companyMayOperate / licenseGate itself
//   platform_admin  Inaya admin portal (isAdminAuthenticated) -- not a company surface
//   cron            scheduled job (CRON_SECRET); jobs acting for a company check companyMayOperate per company
//   not_company     no company data (public pages, wallet / dApp, sign-in, health, webhooks from providers)
//   exempt          deliberately open when restricted (session, help, billing) -- listed in EXEMPT below
//   REVIEW          touches company data without one of the above: must be fixed or justified
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const API = path.join(ROOT, "src", "app", "api");

// Routes that serve company data without a member session but are justified (see the permission matrix doc).
export const JUSTIFIED = {
  "help/ticket": "Help & Support to Inaya: must stay open for a suspended company (SOW 9.2 'Contact support').",
  "help/config": "Help & Support configuration (no company data).",
  "orgs/session": "Sign-in state and the company list: needed to reach Billing and export while restricted.",
  "orgs/logout": "Signing out.",
  "orgs/login/request": "Requesting a sign-in link (no company data).",
  "orgs/mfa/status": "The signed-in person's own MFA status (no company data).",
  "orgs/pending-approvals": "The signed-in person's own pending join requests (no company data).",
  "orgs/create": "Creating a new company (its own license starts unassigned).",
  "stripe-webhook": "Provider webhook (card checkout is retired); writes billing state only.",
  "connect/whatsapp": "Meta's signed WhatsApp webhook: messages are stored while restricted so none are lost; processPending (src/lib/connect/process.js) checks companyMayOperate and answers nothing for a restricted company.",
  "public/workspace-domain": "Custom-domain lookup for the sign-in page: only the company's public branding (name, logo, colours), never company data.",
  "feedback/upload": "Product feedback to Inaya, not company data.",
  "support/inbound-email/[slug]": "Customers' emails are received and kept while restricted, so no company data is lost; nothing is served.",
  "wallet/s3-compat/credentials": "dApp wallet storage keys: not Business Workspace (SOW 2.1).",
  "wallet/s3-compat/credentials/[accessKeyId]": "dApp wallet storage keys: not Business Workspace (SOW 2.1).",
};
// Inaya's own investor data room (src/lib/dataroom.js): founder-owned, not a company surface.
const NOT_COMPANY_PREFIXES = ["dataroom/"];

// Shared helpers that reach company data without a member session and run the license gate themselves
// (test/license-route-coverage.test.mjs checks each helper's source really does).
export const GATED_HELPERS = {
  requireApiKey: "src/lib/api-keys.js", requireSupportApiKey: "src/lib/support/apiKeys.js", authenticateS3Request: "src/lib/s3-compat/auth.js",
  authenticateAzureRequest: "src/lib/s3-compat/azureAuthMiddleware.js", resolveAccessKey: "src/lib/infrastructure/awsCredentials.js",
  getRoomSession: "src/lib/external-data-room.js", getRoomByToken: "src/lib/meet/rooms.js", verifyWebhook: "src/lib/workflows/service.js",
  enrollNode: "src/lib/infrastructure/nodes.js", resolveShareAccess: "src/lib/document-permissions.js", consumeDocumentShare: "src/lib/document-permissions.js",
  shareByToken: "src/lib/sharing/shares.js", handlePublic: "src/lib/support/publicApi.js (calls requireSupportApiKey)", orgBySlug: "src/lib/support/settings.js", byToken: "src/lib/filerequests/requests.js", activePage: "src/lib/engagement/booking.js",
};
// Functions whose callers reach company data only through one of the helpers above.
const VIA_GATED = /\b(requireApiKey|requireSupportApiKey|authenticateS3Request|authenticateAzureRequest|resolveAccessKey|getRoomSession|listRoomDocuments|acceptRoomNda|getRoomByToken|verifyWebhook|enrollNode|resolveShareAccess|peekShare|openShare|shareContent|orgBySlug|beginUpload|uploadPart|completeUpload|publicInfo|publicPage|publicSlots|publicStart|publicBook|publicEnquiry|publicRoute|identityRoute|authenticateGateway|handlePublic)\s*\(/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (name === "route.js") out.push(p);
  }
  return out;
}

export function classify(src, rel) {
  if (JUSTIFIED[rel]) return "exempt";
  if (NOT_COMPANY_PREFIXES.some((p) => rel.startsWith(p))) return "not_company";
  if (/(?<!function\s)requireMembership\s*\(/.test(src)) return "member";
  if (/(?<!function\s)(companyMayOperate|licenseGate)\s*\(/.test(src) || VIA_GATED.test(src)) return "license_gated";
  if (/isAdminAuthenticated\s*\(/.test(src)) return "platform_admin";
  if (/isAuthorizedCron\s*\(|CRON_SECRET/.test(src)) return "cron";
  const company = /\borgId\b|orgDocuments|getOrgCollections|\bshareToken\b|requireApiKey|requireSupportApiKey|s3-compat|azure|portal|fileRequest|dataroom|vdr/i.test(src);
  return company ? "REVIEW" : "not_company";
}

// A route's own source plus the local helper files it imports (e.g. chat/_lib.js, documents-automation/_lib.js), followed
// two levels deep, so a route whose helper calls requireMembership counts as gated.
function sourceWithHelpers(file, depth = 2, seen = new Set()) {
  if (seen.has(file)) return ""; seen.add(file);
  let src = ""; try { src = readFileSync(file, "utf8"); } catch { return ""; }
  if (depth <= 0) return src;
  const helpers = [...src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => path.resolve(path.dirname(file), m[1]))
    .filter((p) => p.startsWith(API) || /[\\/]_[^\\/]*\.js$/.test(p));
  return src + "\n" + helpers.map((h) => sourceWithHelpers(h.endsWith(".js") ? h : `${h}.js`, depth - 1, seen)).join("\n");
}

export function coverage() {
  return walk(API).sort().map((file) => {
    const rel = path.relative(API, path.dirname(file)).split(path.sep).join("/");
    return { route: rel, kind: classify(sourceWithHelpers(file), rel) };
  });
}

if (process.argv[1] && process.argv[1].endsWith("license-route-coverage.mjs")) {
  const rows = coverage();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  const counts = rows.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
  console.log(`${rows.length} API routes:`, counts);
  const review = rows.filter((r) => r.kind === "REVIEW");
  if (review.length) { console.log(`\n${review.length} routes need review:`); for (const r of review) console.log("  ", r.route); }
}
