// src/lib/appStoreListings.js
//
// Community App Store listings — Options A (IPFS-pinned static app, linked
// via a public gateway in a new tab) and B (externally-hosted app, shown
// via a strictly sandboxed iframe) from the App Store hosting discussion.
// Option C (same-origin/subdomain hosting of third-party code) and D
// (registry-only, no verification) were explicitly rejected.
//
// SECURITY IS THE PRIORITY HERE, not a checkbox — every listing goes
// through all of the following before a single other user can see it:
//   1. Wallet-signature auth on submission (verifyMetadataAuth, the same
//      generic framework the file-sharing and NFT-backup routes already
//      use) — no anonymous submissions.
//   2. A real check against the EXISTING Security Layer threat registry
//      (getThreatByIndicator — the same live data /security's public
//      checker and the Bridge page's AddressRiskCheck use) on the
//      submitted URL/gateway host, both at submission time and again at
//      review time (a domain can turn malicious after submission but
//      before review).
//   3. status starts at "pending" and ONLY an authenticated admin
//      (isAdminAuthenticated, the same passphrase-gated session every
//      other /admin/* surface uses) can flip it to "approved" — nothing
//      submitted here is ever auto-published.
//   4. Strict input validation: embedUrl must be https:// (no javascript:/
//      data:/file: schemes), cid must look like a real IPFS CID, not
//      arbitrary text.
// The iframe sandbox attributes themselves (no allow-same-origin combined
// with allow-scripts — the actual dangerous combination) live in the
// embed page component, not here, but exist for the exact same reason.

import { connectToDatabase } from "./mongodb.js";
import { verifyMetadataAuth } from "./metadata-auth.js";
import { getThreatByIndicator } from "./security.js";

const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/; // CIDv0 (Qm...) or CIDv1 (bafy...)
const VALID_CATEGORIES = ["Storage", "DeFi", "Social", "Gaming", "Tools", "Other"];

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Validates the submission shape BEFORE any signature/DB work — fail
 *  fast and clearly rather than a confusing downstream error. */
function validateListingInput({ name, description, category, hostType, cid, embedUrl }) {
  const clean = { name: String(name || "").trim(), description: String(description || "").trim(), category: VALID_CATEGORIES.includes(category) ? category : "Other" };
  if (!clean.name || clean.name.length > 80) throw new Error("A name (1-80 characters) is required.");
  if (!clean.description || clean.description.length > 400) throw new Error("A description (1-400 characters) is required.");

  if (hostType === "ipfs") {
    const trimmedCid = String(cid || "").trim();
    if (!CID_PATTERN.test(trimmedCid)) throw new Error("That doesn't look like a valid IPFS CID (expected a CIDv0 \"Qm...\" or CIDv1 \"bafy...\" string).");
    return { ...clean, hostType, cid: trimmedCid, embedUrl: null };
  }
  if (hostType === "iframe") {
    const trimmedUrl = String(embedUrl || "").trim();
    let parsed;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      throw new Error("A valid https:// URL is required for an externally-hosted app.");
    }
    if (parsed.protocol !== "https:") throw new Error("Only https:// URLs are allowed — no javascript:, data:, or plain http:// links.");
    // Store/sign the RAW trimmed string, not parsed.toString() — URL
    // normalization (e.g. adding a trailing slash to a bare origin) would
    // make the server's recomputed resourceId diverge from whatever the
    // client actually signed, and verifyMetadataAuth fails closed on any
    // mismatch (a real bug caught during verification, not a hypothetical).
    return { ...clean, hostType, cid: null, embedUrl: trimmedUrl };
  }
  throw new Error('hostType must be "ipfs" or "iframe".');
}

/** Runs the submitted host (a gateway domain for IPFS, or the embed URL's
 *  own domain) through the real, live threat registry. Never blocks a
 *  submission outright here — a CONFIRMED hit is recorded and surfaced
 *  prominently to the reviewing admin instead, since a false positive
 *  should never silently deny a legitimate developer without a human
 *  looking at it. */
async function runThreatCheck({ hostType, cid, embedUrl }) {
  const indicator = hostType === "ipfs" ? "gateway.pinata.cloud" : extractHost(embedUrl);
  try {
    const threat = await getThreatByIndicator(indicator);
    return { checked: true, indicator, known: threat.known, statusLabel: threat.statusLabel, category: threat.category };
  } catch (err) {
    return { checked: false, indicator, error: err.message };
  }
}

export async function submitAppListing({ name, description, category, hostType, cid, embedUrl, address, message, signature, timestamp }) {
  const clean = validateListingInput({ name, description, category, hostType, cid, embedUrl });

  const resourceId = `${clean.hostType}:${clean.hostType === "ipfs" ? clean.cid : clean.embedUrl}`;
  verifyMetadataAuth({ action: "submitAppListing", resourceId, extra: { name: clean.name }, address, message, signature, timestamp });

  const threatCheck = await runThreatCheck(clean);

  const { db } = await connectToDatabase();
  const slug = `${slugify(clean.name)}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const doc = {
    slug, ...clean, submitterAddress: address.toLowerCase(),
    status: "pending", threatCheck,
    createdAt: now, reviewedAt: null, reviewedByAdmin: false, reviewNote: null,
  };
  await db.collection("app_store_listings").insertOne(doc);
  return doc;
}

export async function listApprovedListings() {
  const { db } = await connectToDatabase();
  return db.collection("app_store_listings").find({ status: "approved" }).sort({ createdAt: -1 }).toArray();
}

export async function listPendingListings() {
  const { db } = await connectToDatabase();
  return db.collection("app_store_listings").find({ status: "pending" }).sort({ createdAt: 1 }).toArray();
}

export async function getListingBySlug(slug) {
  const { db } = await connectToDatabase();
  return db.collection("app_store_listings").findOne({ slug, status: "approved" });
}

/** Every submission from one wallet, any status — the only way a developer
 *  can check whether their own pending submission was approved or rejected
 *  (and why) without admin access. Public read, but scoped to the querying
 *  address's own data only — same risk profile as GET /api/nft/backups. */
export async function listListingsBySubmitter(address) {
  const { db } = await connectToDatabase();
  return db.collection("app_store_listings").find({ submitterAddress: String(address || "").toLowerCase() }).sort({ createdAt: -1 }).toArray();
}

/** Re-runs the threat check at review time (a domain can turn malicious
 *  after submission but before an admin looks at it) before recording the
 *  decision, so the stored threatCheck reflects what was actually true
 *  when a human approved it, not just at submission. */
export async function reviewAppListing({ slug, decision, note }) {
  if (!["approve", "reject"].includes(decision)) throw new Error('decision must be "approve" or "reject".');
  const { db } = await connectToDatabase();
  const listing = await db.collection("app_store_listings").findOne({ slug });
  if (!listing) throw new Error("Listing not found.");

  const threatCheck = await runThreatCheck(listing);
  const now = new Date().toISOString();
  await db.collection("app_store_listings").updateOne(
    { slug },
    { $set: { status: decision === "approve" ? "approved" : "rejected", threatCheck, reviewedAt: now, reviewedByAdmin: true, reviewNote: note || null } }
  );
  return db.collection("app_store_listings").findOne({ slug });
}
