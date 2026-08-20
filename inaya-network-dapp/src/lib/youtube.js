// src/lib/youtube.js
//
// Server-only client for the YouTube Data API v3 (search + video details),
// used by Inaya Learn. YOUTUBE_API_KEY is read fresh from process.env
// inside each function (never at module load, so a missing key doesn't
// crash unrelated routes) and never sent to the client — same discipline
// as didit.js.
//
// Caching (learn_search_cache / learn_video_cache, both TTL-indexed via
// ensureLearnIndexes()) is not optional here: search.list costs 100 quota
// units per call against a default 10,000/day project quota — uncached,
// that's ~100 searches/day for the entire app. videos.list is cheap
// (1 unit/call) but still cached for consistency and to avoid re-fetching
// detail for videos already seen in a recent search.
//
// Note: YouTube deprecated the `relatedToVideoId` parameter on search.list
// in 2023 — there is no official "related videos" API call anymore. Related
// content in this app is sourced from same-category/collection results
// instead (see the learn/video route), not implemented here.

import { getLearnCollections, buildSearchCacheKey, SEARCH_CACHE_TTL_MS, VIDEO_CACHE_TTL_MS } from "./learn.js";
import { LEARN_CATEGORIES } from "./learnConfig.js";

const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";
const EDUCATION_CATEGORY_ID = "27"; // YouTube's built-in "Education" video category

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export class YouTubeQuotaExceededError extends Error {
  constructor() {
    super("YouTube API daily quota exceeded — please try again later.");
    this.name = "YouTubeQuotaExceededError";
  }
}

/** Extracts only the structured `reason` field from a failed response, never
 *  the raw body — same "never surface a raw response body from a call that
 *  carried a credential" policy as didit.js. */
async function extractErrorReason(res) {
  try {
    const body = await res.json();
    return body?.error?.errors?.[0]?.reason || null;
  } catch {
    return null;
  }
}

function throwForFailedResponse(res, action, reason) {
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
    throw new YouTubeQuotaExceededError();
  }
  throw new Error(`YouTube ${action} failed (HTTP ${res.status}).`);
}

/** ISO 8601 duration ("PT15M33S") -> whole seconds. YouTube's contentDetails
 *  never returns fractional seconds for this field in practice, but the
 *  regex tolerates it defensively. */
export function parseIsoDurationToSeconds(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || "");
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return Math.round(hours * 3600 + minutes * 60 + seconds);
}

function categoryKeywords(categoryId) {
  const cat = LEARN_CATEGORIES.find((c) => c.id === categoryId);
  return cat?.searchKeywords || "";
}

/** Searches for educational videos. Applies YouTube's built-in Education
 *  category (videoCategoryId=27) plus a category-specific keyword boost as
 *  relevance signals — this is a boost, not a guarantee; the UI must label
 *  results "Educational results" rather than claim certainty (spec §4). */
export async function searchEducationalVideos({ query, categoryId, pageToken }) {
  const cacheKey = buildSearchCacheKey({ query, categoryId, pageToken });
  const { searchCache } = await getLearnCollections();

  const cached = await searchCache.findOne({ cacheKey });
  if (cached) {
    return { results: cached.results, nextPageToken: cached.nextPageToken || null, fromCache: true };
  }

  const apiKey = requireEnv("YOUTUBE_API_KEY");
  const keywords = categoryKeywords(categoryId);
  const augmentedQuery = keywords ? `${query} ${keywords}` : query;

  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoCategoryId: EDUCATION_CATEGORY_ID,
    maxResults: "20",
    q: augmentedQuery,
    safeSearch: "strict",
    key: apiKey,
  });
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(`${YOUTUBE_BASE_URL}/search?${params.toString()}`);
  if (!res.ok) {
    throwForFailedResponse(res, "search", await extractErrorReason(res));
  }

  const data = await res.json();
  const results = (data.items || [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet?.title || "",
      channelTitle: item.snippet?.channelTitle || "",
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
      description: item.snippet?.description || "",
      publishedAt: item.snippet?.publishedAt || null,
    }));
  const nextPageToken = data.nextPageToken || null;

  await searchCache.updateOne(
    { cacheKey },
    { $set: { cacheKey, results, nextPageToken, cachedAt: new Date(), expiresAt: new Date(Date.now() + SEARCH_CACHE_TTL_MS) } },
    { upsert: true }
  );

  return { results, nextPageToken, fromCache: false };
}

/** Batched detail lookup (duration, view count, full description) — up to
 *  50 ids per YouTube API call. Missing/private/deleted videos simply don't
 *  appear in the response and are silently dropped from the result, per
 *  spec §18's "handle removed/private videos gracefully." Returns results
 *  in the same order as the input ids (minus any that dropped out). */
export async function getVideoDetails(videoIds) {
  const uniqueIds = [...new Set((videoIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const { videoCache } = await getLearnCollections();
  const cachedDocs = await videoCache.find({ videoId: { $in: uniqueIds } }).toArray();
  const cachedById = new Map(cachedDocs.map((doc) => [doc.videoId, doc.detail]));

  const missingIds = uniqueIds.filter((id) => !cachedById.has(id));

  if (missingIds.length > 0) {
    const apiKey = requireEnv("YOUTUBE_API_KEY");
    for (let i = 0; i < missingIds.length; i += 50) {
      const chunk = missingIds.slice(i, i + 50);
      const params = new URLSearchParams({
        part: "snippet,contentDetails,statistics",
        id: chunk.join(","),
        key: apiKey,
      });
      const res = await fetch(`${YOUTUBE_BASE_URL}/videos?${params.toString()}`);
      if (!res.ok) {
        throwForFailedResponse(res, "video detail lookup", await extractErrorReason(res));
      }
      const data = await res.json();
      const now = new Date();
      const expiresAt = new Date(Date.now() + VIDEO_CACHE_TTL_MS);

      const writes = (data.items || []).map((item) => {
        const detail = {
          videoId: item.id,
          title: item.snippet?.title || "",
          channelTitle: item.snippet?.channelTitle || "",
          thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
          description: item.snippet?.description || "",
          publishedAt: item.snippet?.publishedAt || null,
          durationSeconds: parseIsoDurationToSeconds(item.contentDetails?.duration),
          viewCount: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
        };
        cachedById.set(item.id, detail);
        return videoCache.updateOne(
          { videoId: item.id },
          { $set: { videoId: item.id, detail, cachedAt: now, expiresAt } },
          { upsert: true }
        );
      });
      await Promise.all(writes);
    }
  }

  return uniqueIds.map((id) => cachedById.get(id)).filter(Boolean);
}
