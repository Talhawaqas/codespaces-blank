// src/lib/feedback.js
//
// Testnet Feedback System — bug reports and idea submissions from the
// dApp, triaged from the admin dashboard. Same collection/lib shape as
// referrals.js/watcherPioneer.js (getXCollections/ensureXIndexes), single
// collection, no auth required to submit (matches referrals/activate's
// openness) — admin read/write routes are gated separately by the same
// ADMIN_DASHBOARD_SECRET key already used for /admin/dashboard.

import { connectToDatabase } from "./mongodb.js";

export const FEEDBACK_TYPES = ["bug", "idea"];
export const FEEDBACK_CATEGORIES = [
  "Watcher Node",
  "File Upload",
  "Storage",
  "Mobile",
  "Business Workspace",
  "AI Assistant",
  "Authentication",
  "Other",
];
export const FEEDBACK_SEVERITIES = ["Low", "Medium", "High", "Critical"];
export const FEEDBACK_STATUSES = ["New", "Reviewing", "Confirmed", "In Progress", "Resolved", "Rejected"];

const MAX_TITLE_LEN = 200;
const MAX_DESCRIPTION_LEN = 5000;
const MAX_STEPS_LEN = 3000;
const MAX_SHORT_FIELD_LEN = 500; // device/browser/network/route/attachmentUrl/walletAddress

export async function getFeedbackCollections() {
  const { db } = await connectToDatabase();
  return { db, feedback: db.collection("feedback_submissions") };
}

let indexesEnsured = false;

export async function ensureFeedbackIndexes() {
  if (indexesEnsured) return;
  const { feedback } = await getFeedbackCollections();
  await Promise.all([
    feedback.createIndex({ type: 1 }),
    feedback.createIndex({ status: 1 }),
    feedback.createIndex({ createdAt: -1 }),
  ]);
  indexesEnsured = true;
}

function isNonEmptyString(v, maxLen) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

/** Throws a descriptive Error on any violation — fails closed, same
 *  convention as verifyMetadataAuth/verifyWatcherAuth in this codebase.
 *  Returns a clean, trimmed object of exactly the fields that get stored,
 *  so callers can't smuggle extra/unexpected keys into the document. */
export function validateFeedbackInput(input) {
  const { type, title, description, category, severity, reproductionSteps } = input || {};

  if (!FEEDBACK_TYPES.includes(type)) {
    throw new Error('type must be "bug" or "idea".');
  }
  if (!isNonEmptyString(title, MAX_TITLE_LEN)) {
    throw new Error(`Title is required (max ${MAX_TITLE_LEN} characters).`);
  }
  if (!isNonEmptyString(description, MAX_DESCRIPTION_LEN)) {
    throw new Error(`Description is required (max ${MAX_DESCRIPTION_LEN} characters).`);
  }
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    throw new Error(`Category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}.`);
  }

  let cleanSeverity = null;
  let cleanSteps = null;
  if (type === "bug") {
    if (!FEEDBACK_SEVERITIES.includes(severity)) {
      throw new Error(`Severity must be one of: ${FEEDBACK_SEVERITIES.join(", ")} (required for bugs).`);
    }
    cleanSeverity = severity;
    if (reproductionSteps != null) {
      if (!isNonEmptyString(reproductionSteps, MAX_STEPS_LEN)) {
        throw new Error(`Steps to reproduce must be under ${MAX_STEPS_LEN} characters.`);
      }
      cleanSteps = reproductionSteps.trim();
    }
  } else if (severity != null || reproductionSteps != null) {
    throw new Error("Severity and reproduction steps only apply to bug reports.");
  }

  return {
    type,
    title: title.trim(),
    description: description.trim(),
    category,
    severity: cleanSeverity,
    reproductionSteps: cleanSteps,
  };
}

/** Trims and length-caps the auto-captured/optional context fields —
 *  these are informational, not user-authored form content, so they get a
 *  lighter touch than validateFeedbackInput's required-field checks:
 *  anything too long or the wrong type is just dropped to null rather
 *  than rejecting the whole submission over a malformed User-Agent. */
export function cleanContextFields({ attachmentUrl, route, walletAddress, device, browser, network }) {
  const clean = (v) => (isNonEmptyString(v, MAX_SHORT_FIELD_LEN) ? v.trim() : null);
  return {
    attachmentUrl: clean(attachmentUrl),
    route: clean(route),
    walletAddress: clean(walletAddress),
    device: clean(device),
    browser: clean(browser),
    network: clean(network),
  };
}
