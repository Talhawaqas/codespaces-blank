// src/lib/support/uploadRoutes.js
//
// Thin HTTP layer for chunked uploads. `resolve(req, routeCtx)` authenticates the caller for one surface
// (portal / agent / public API) and returns { ctx } or { error, status }. Everything else is identical.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../orgs.js";
import { checkRateLimit } from "../rateLimit.js";
import { upInit, upChunk, upComplete } from "./uploadsApi.js";
import { CHUNK_BYTES } from "./uploads.js";

const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}), ...(r.received ? { received: r.received } : {}) }, r.status || 400) : json(r));

async function guard(resolve, req, routeCtx, rate) {
  await ensureOrgIndexes();
  const a = await resolve(req, routeCtx);
  if (a.error) return { res: json({ error: a.error }, a.status || 401) };
  try { await checkRateLimit({ action: `support:upload:${a.ctx.kind}`, key: String(a.ctx.owner || a.ctx.user?._id || a.ctx.email || a.ctx.keyId), max: rate, windowMs: 3600000 }); } catch { return { res: json({ error: "Too many uploads. Please wait a little." }, 429) }; }
  return { ctx: a.ctx };
}

export function initHandler(resolve) {
  return async function POST(req, routeCtx) {
    try {
      const g = await guard(resolve, req, routeCtx, 120); if (g.res) return g.res;
      const body = await req.json().catch(() => ({}));
      return out(await upInit(g.ctx, body));
    } catch (err) { console.error("support upload init failed:", err?.message); return json({ error: "Something went wrong. Please try again." }, 500); }
  };
}

export function chunkHandlers(resolve) {
  return {
    async PUT(req, routeCtx) {
      try {
        const g = await guard(resolve, req, routeCtx, 2000); if (g.res) return g.res;
        if (Number(req.headers.get("content-length") || 0) > CHUNK_BYTES + 1024) return json({ error: "Chunk too large." }, 413);
        const { id } = await routeCtx.params;
        const index = new URL(req.url).searchParams.get("index");
        const buf = Buffer.from(await req.arrayBuffer());
        return out(await upChunk(g.ctx, id, index, buf));
      } catch (err) { console.error("support upload chunk failed:", err?.message); return json({ error: "Something went wrong. Please try again." }, 500); }
    },
    async POST(req, routeCtx) {
      try {
        const g = await guard(resolve, req, routeCtx, 240); if (g.res) return g.res;
        const { id } = await routeCtx.params;
        return out(await upComplete(g.ctx, id));
      } catch (err) { console.error("support upload complete failed:", err?.message); return json({ error: "Something went wrong. Please try again." }, 500); }
    },
  };
}
