// app/api/learn/video/[videoId]/route.js
//
// GET /api/learn/video/:videoId — public. Cached video detail lookup
// (title, channel, description, duration, view count). Also accepts
// ?related=categoryId to return a few more results from the same category
// as a substitute for YouTube's deprecated relatedToVideoId search param
// (removed from the API in 2023 — see src/lib/youtube.js's header comment).

import { NextResponse } from "next/server";
import { getVideoDetails, searchEducationalVideos, YouTubeQuotaExceededError } from "../../../../../lib/youtube.js";
import { LEARN_CATEGORIES } from "../../../../../lib/learnConfig.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const { videoId } = params;
    if (!videoId) {
      return NextResponse.json({ error: "videoId is required." }, { status: 400 });
    }

    const [detail] = await getVideoDetails([videoId]);
    if (!detail) {
      return NextResponse.json({ error: "This video is unavailable, private, or has been removed." }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const relatedCategoryId = searchParams.get("related");
    let more = [];
    if (relatedCategoryId && LEARN_CATEGORIES.some((c) => c.id === relatedCategoryId)) {
      const cat = LEARN_CATEGORIES.find((c) => c.id === relatedCategoryId);
      const { results } = await searchEducationalVideos({ query: cat.name, categoryId: relatedCategoryId, pageToken: null });
      more = results.filter((r) => r.videoId !== videoId).slice(0, 8);
    }

    return NextResponse.json({ video: detail, more });
  } catch (err) {
    if (err instanceof YouTubeQuotaExceededError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error("learn/video failed:", err);
    return NextResponse.json({ error: "Could not load this video." }, { status: 502 });
  }
}
