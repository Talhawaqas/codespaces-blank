// app/api/admin/rag/reingest/route.js
//
// POST /api/admin/rag/reingest — admin-triggered, on-demand re-ingestion
// of every static RAG source (Docs + Security's static docs + Learn's
// config). Same isAdminAuthenticated guard as every other /api/admin/*
// route. Also called automatically overnight by /api/cron/rag-reingest —
// this route is the shared implementation, manual trigger just skips the
// wait.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ingestAllStaticSources } from "../../../../../lib/rag/ingest.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // embedding ~15 sources' worth of chunks can take a while on first run

export async function POST(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const results = await ingestAllStaticSources();
    const totals = results.reduce(
      (acc, r) => ({
        chunksAdded: acc.chunksAdded + (r.chunksAdded || 0),
        chunksUpdated: acc.chunksUpdated + (r.chunksUpdated || 0),
        chunksRemoved: acc.chunksRemoved + (r.chunksRemoved || 0),
        errors: acc.errors + (r.error ? 1 : 0),
      }),
      { chunksAdded: 0, chunksUpdated: 0, chunksRemoved: 0, errors: 0 }
    );
    return NextResponse.json({ sources: results.length, ...totals, results });
  } catch (err) {
    console.error("admin/rag/reingest failed:", err);
    return NextResponse.json({ error: "Re-ingestion failed." }, { status: 500 });
  }
}
