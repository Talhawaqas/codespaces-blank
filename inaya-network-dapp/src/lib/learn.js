// src/lib/learn.js
//
// Inaya Learn — educational YouTube video discovery, save/bookmark, and
// watch-progress tracking. Same collection/lib shape as feedback.js/
// watcherPioneer.js (getXCollections/ensureXIndexes/validateXInput).
//
// Data identity: local-first on the mobile client (AsyncStorage) with
// optional backend sync keyed by walletAddress once a wallet is connected
// — same trust model already used by referrals.js/watcherPioneer.js's
// non-signature-verified paths (client-provided address, no session/auth
// system for this feature). Saved/progress records with no walletAddress
// simply never reach this backend; the mobile app is the source of truth
// for anonymous users.
//
// Search/video response caching lives here too (learn_search_cache,
// learn_video_cache) rather than in youtube.js, so all Learn collections —
// including the TTL-based caches — share one place to look for indexes.

import { connectToDatabase } from "./mongodb.js";

export const LEARN_STATUSES = ["watching", "completed"];
export const LEARN_REPORT_REASONS = ["not_educational", "unavailable", "inappropriate", "other"];

const MAX_NOTE_LEN = 1000;
const MAX_TITLE_LEN = 300;
const MAX_SHORT_FIELD_LEN = 300; // channel, thumbnail URL, category id, etc.
const MAX_REASON_DETAIL_LEN = 500;

export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — search results churn slowly, quota is the binding constraint
export const VIDEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getLearnCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    saved: db.collection("learn_saved"),
    progress: db.collection("learn_progress"),
    searchCache: db.collection("learn_search_cache"),
    videoCache: db.collection("learn_video_cache"),
    reports: db.collection("learn_reports"),
    analytics: db.collection("learn_analytics_events"),
  };
}

let indexesEnsured = false;

export async function ensureLearnIndexes() {
  if (indexesEnsured) return;
  const { saved, progress, searchCache, videoCache, reports, analytics } = await getLearnCollections();

  await Promise.all([
    saved.createIndex({ walletAddress: 1, videoId: 1 }, { unique: true }),
    saved.createIndex({ walletAddress: 1, savedAt: -1 }),
    progress.createIndex({ walletAddress: 1, videoId: 1 }, { unique: true }),
    progress.createIndex({ walletAddress: 1, status: 1, updatedAt: -1 }),
    searchCache.createIndex({ cacheKey: 1 }, { unique: true }),
    searchCache.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    videoCache.createIndex({ videoId: 1 }, { unique: true }),
    videoCache.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    reports.createIndex({ createdAt: -1 }),
    analytics.createIndex({ createdAt: -1 }),
  ]);

  indexesEnsured = true;
}

function isNonEmptyString(v, maxLen) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

function isValidWallet(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

export function normalizeWallet(address) {
  if (typeof address !== "string") return "";
  return address.trim().toLowerCase();
}

/** Throws a descriptive Error on any violation — same fail-closed
 *  convention as validateFeedbackInput. Returns a clean object of exactly
 *  the fields that get stored. */
export function validateSaveInput(input) {
  const { walletAddress, videoId, title, thumbnailUrl, channelTitle, categoryId } = input || {};

  if (!isValidWallet(walletAddress)) {
    throw new Error("A valid wallet address is required to save a video.");
  }
  if (!isNonEmptyString(videoId, 50)) {
    throw new Error("videoId is required.");
  }
  if (!isNonEmptyString(title, MAX_TITLE_LEN)) {
    throw new Error(`Video title is required (max ${MAX_TITLE_LEN} characters).`);
  }
  if (thumbnailUrl != null && !isNonEmptyString(thumbnailUrl, 500)) {
    throw new Error("thumbnailUrl is too long.");
  }
  if (channelTitle != null && !isNonEmptyString(channelTitle, MAX_SHORT_FIELD_LEN)) {
    throw new Error("channelTitle is too long.");
  }
  if (categoryId != null && !isNonEmptyString(categoryId, MAX_SHORT_FIELD_LEN)) {
    throw new Error("categoryId is too long.");
  }

  return {
    walletAddress: normalizeWallet(walletAddress),
    videoId: videoId.trim(),
    title: title.trim(),
    thumbnailUrl: thumbnailUrl ? thumbnailUrl.trim() : null,
    channelTitle: channelTitle ? channelTitle.trim() : null,
    categoryId: categoryId ? categoryId.trim() : null,
  };
}

/** positionSeconds/durationSeconds are used to compute "N% complete" and
 *  resume playback — status flips to "completed" client-side (or here, if
 *  the caller passes it) once playback nears the end; this function does
 *  not infer completion on its own. */
export function validateProgressInput(input) {
  const { walletAddress, videoId, title, thumbnailUrl, channelTitle, positionSeconds, durationSeconds, status } = input || {};

  if (!isValidWallet(walletAddress)) {
    throw new Error("A valid wallet address is required to sync progress.");
  }
  if (!isNonEmptyString(videoId, 50)) {
    throw new Error("videoId is required.");
  }
  if (!isNonEmptyString(title, MAX_TITLE_LEN)) {
    throw new Error(`Video title is required (max ${MAX_TITLE_LEN} characters).`);
  }
  if (!LEARN_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${LEARN_STATUSES.join(", ")}.`);
  }
  if (typeof positionSeconds !== "number" || positionSeconds < 0) {
    throw new Error("positionSeconds must be a non-negative number.");
  }
  if (typeof durationSeconds !== "number" || durationSeconds < 0) {
    throw new Error("durationSeconds must be a non-negative number.");
  }

  return {
    walletAddress: normalizeWallet(walletAddress),
    videoId: videoId.trim(),
    title: title.trim(),
    thumbnailUrl: isNonEmptyString(thumbnailUrl, 500) ? thumbnailUrl.trim() : null,
    channelTitle: isNonEmptyString(channelTitle, MAX_SHORT_FIELD_LEN) ? channelTitle.trim() : null,
    positionSeconds,
    durationSeconds,
    status,
  };
}

export function validateReportInput(input) {
  const { videoId, reason, detail, walletAddress } = input || {};

  if (!isNonEmptyString(videoId, 50)) {
    throw new Error("videoId is required.");
  }
  if (!LEARN_REPORT_REASONS.includes(reason)) {
    throw new Error(`reason must be one of: ${LEARN_REPORT_REASONS.join(", ")}.`);
  }
  if (detail != null && !isNonEmptyString(detail, MAX_REASON_DETAIL_LEN)) {
    throw new Error(`detail must be under ${MAX_REASON_DETAIL_LEN} characters.`);
  }
  if (walletAddress != null && !isValidWallet(walletAddress)) {
    throw new Error("walletAddress, if provided, must be a valid address.");
  }

  return {
    videoId: videoId.trim(),
    reason,
    detail: detail ? detail.trim() : null,
    walletAddress: walletAddress ? normalizeWallet(walletAddress) : null,
  };
}

const ANALYTICS_EVENTS = [
  "learn_opened",
  "search_performed",
  "result_selected",
  "video_started",
  "video_completed",
  "video_saved",
  "video_unsaved",
  "collection_opened",
  "external_provider_selected",
];

/** No PII collection by design (spec §14) — metadata is limited to what's
 *  needed for aggregated product-usage counts (event type, category,
 *  videoId where relevant). Throws on an unrecognized event name rather
 *  than silently accepting arbitrary client-supplied event types. */
export function validateAnalyticsInput(input) {
  const { event, categoryId, videoId } = input || {};

  if (!ANALYTICS_EVENTS.includes(event)) {
    throw new Error(`event must be one of: ${ANALYTICS_EVENTS.join(", ")}.`);
  }
  if (categoryId != null && !isNonEmptyString(categoryId, MAX_SHORT_FIELD_LEN)) {
    throw new Error("categoryId is too long.");
  }
  if (videoId != null && !isNonEmptyString(videoId, 50)) {
    throw new Error("videoId is too long.");
  }

  return {
    event,
    categoryId: categoryId ? categoryId.trim() : null,
    videoId: videoId ? videoId.trim() : null,
  };
}

/** Normalizes a search request into a stable cache key so "python" and
 *  " Python  " hit the same cache entry. Category + pageToken are part of
 *  the key since they change the actual result set. */
export function buildSearchCacheKey({ query, categoryId, pageToken }) {
  const q = (query || "").trim().toLowerCase().replace(/\s+/g, " ");
  const cat = (categoryId || "").trim().toLowerCase();
  const page = (pageToken || "").trim();
  return `${q}|${cat}|${page}`;
}

export { MAX_NOTE_LEN };
