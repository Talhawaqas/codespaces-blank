// app/api/cron/rag-reingest/route.js
//
// GET /api/cron/rag-reingest — nightly automatic re-ingestion, same
// CRON_SECRET bearer-token pattern as the existing
// /api/security/cron/checkpoint-reputation (Vercel Cron attaches
// `Authorization: Bearer $CRON_SECRET` automatically to scheduled
// invocations; see vercel.json's "crons" entry for this route).
// Incremental by design (ingestAllStaticSources -> ingestSource's
// content-hash diffing) — a nightly run only re-embeds what actually
// changed since the last run, never a full rebuild.

import { NextResponse } from "next/server";
import { ingestAllStaticSources } from "../../../../lib/rag/ingest.js";

export const maxDuration = 300;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const results = await ingestAllStaticSources();
    return NextResponse.json({ success: true, sources: results.length });
  } catch (err) {
    console.error("cron/rag-reingest failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
