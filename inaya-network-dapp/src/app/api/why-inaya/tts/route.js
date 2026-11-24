// app/api/why-inaya/tts/route.js -- narration audio for the Why Inaya explainer (SOW 5.5).
// POST { text, token, voice } -> audio/wav. Speaks ONLY narrations signed by /api/why-inaya/explain (token), so it cannot
// be used as a general text-to-speech service. On any failure the browser falls back to its own voice + transcript.
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { checkRateLimit } from "../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_BODY = 12 * 1024;
const visitorKey = (req) => createHash("sha256").update(`why-inaya:${(req.headers.get("x-forwarded-for") || "local").split(",")[0].trim()}`).digest("hex").slice(0, 32);

export async function POST(req) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Too much data." }, { status: 413 });
  let b; try { b = JSON.parse(raw || "{}"); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const { verifyNarration, synthesize } = await import("../../../../lib/whyInaya/explainer.server.js");
  if (typeof b.text !== "string" || !verifyNarration(b.text, b.token)) return NextResponse.json({ error: "This narration has expired. Please create the explanation again.", code: "BAD_TOKEN" }, { status: 403 });
  try { await checkRateLimit({ action: "why-inaya-tts", key: visitorKey(req), max: 40, windowMs: 60 * 60 * 1000 }); }
  catch { import("../../../../lib/metrics/metrics.js").then((m) => m.metric?.("why_inaya.rate_limited", { label: "tts" })).catch(() => {}); return NextResponse.json({ error: "Voice limit reached for now; the transcript and device voice still work.", code: "RATE_LIMITED" }, { status: 429 }); }
  try {
    const wav = await synthesize(b.text, b.voice === "calm" ? "calm" : "warm");
    import("../../../../lib/metrics/metrics.js").then((m) => m.metric?.("why_inaya.tts", { label: "ok" })).catch(() => {});
    return new NextResponse(wav, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "Content-Length": String(wav.length) } });
  } catch (err) {
    const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(String(err?.message));
    console.warn("why-inaya tts failed:", quota ? "quota" : String(err?.message || err).slice(0, 120));
    import("../../../../lib/metrics/metrics.js").then((m) => m.metric?.("why_inaya.tts", { label: quota ? "quota" : "error" })).catch(() => {});
    return NextResponse.json({ error: "The AI voice is unavailable right now.", code: quota ? "TTS_QUOTA" : "TTS_FAILED" }, { status: 503 });
  }
}
