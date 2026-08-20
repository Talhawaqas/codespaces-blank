// app/api/learn/search/route.js
//
// GET /api/learn/search?q=...&category=...&pageToken=... — public. Proxies
// the YouTube Data API (never exposes YOUTUBE_API_KEY to the client),
// cached via src/lib/youtube.js. Results are labeled "Educational results"
// client-side, not claimed to be certainly educational (spec §4).

import { NextResponse } from "next/server";
import { searchEducationalVideos, YouTubeQuotaExceededError } from "../../../../lib/youtube.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("q") || "").trim();
    const categoryId = searchParams.get("category") || null;
    const pageToken = searchParams.get("pageToken") || null;

    if (!query) {
      return NextResponse.json({ error: "A search query (q) is required." }, { status: 400 });
    }
    if (query.length > 200) {
      return NextResponse.json({ error: "Search query is too long." }, { status: 400 });
    }

    const { results, nextPageToken } = await searchEducationalVideos({ query, categoryId, pageToken });
    return NextResponse.json({ results, nextPageToken });
  } catch (err) {
    if (err instanceof YouTubeQuotaExceededError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err.message?.startsWith("Missing required env var")) {
      return NextResponse.json({ error: "Learn search is not configured yet." }, { status: 500 });
    }
    console.error("learn/search failed:", err);
    return NextResponse.json({ error: "Search failed. Please try again." }, { status: 502 });
  }
}
