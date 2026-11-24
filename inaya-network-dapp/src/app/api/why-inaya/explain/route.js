// app/api/why-inaya/explain/route.js -- public AI explainer for /business/why-inaya (SOW section 5).
// POST { consent: true, answers } -> { result, script, source, narrationToken }
// No sign-in; no tenant data is read. Answers are used for this one response and are never logged or stored.
// Rate limited per (hashed) IP; the request body is size-capped and every field is re-validated server-side.
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { checkRateLimit } from "../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_BODY = 8 * 1024;
const visitorKey = (req) => createHash("sha256").update(`why-inaya:${(req.headers.get("x-forwarded-for") || "local").split(",")[0].trim()}`).digest("hex").slice(0, 32);

export async function POST(req) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Too much data." }, { status: 413 });
  let body; try { body = JSON.parse(raw || "{}"); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (body?.consent !== true) return NextResponse.json({ error: "Please agree to the AI explanation first.", code: "CONSENT_REQUIRED" }, { status: 400 });
  try { await checkRateLimit({ action: "why-inaya-explain", key: visitorKey(req), max: 8, windowMs: 60 * 60 * 1000 }); }
  catch { import("../../../../lib/metrics/metrics.js").then((m) => m.metric?.("why_inaya.rate_limited", { label: "explain" })).catch(() => {}); return NextResponse.json({ error: "You've made several explanations in the last hour. Please try again a little later.", code: "RATE_LIMITED" }, { status: 429 }); }
  try {
    const { explain } = await import("../../../../lib/whyInaya/explainer.server.js");
    const out = await explain(body.answers && typeof body.answers === "object" ? body.answers : {});
    import("../../../../lib/metrics/metrics.js").then((m) => m.metric?.("why_inaya.explain", { label: out.source })).catch(() => {});
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("why-inaya explain failed:", String(err?.message || err).slice(0, 120));
    return NextResponse.json({ error: "The explanation could not be prepared. The rest of the page still works; please try again.", code: "FAILED" }, { status: 500 });
  }
}
