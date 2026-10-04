// app/api/watcher/telegram/poll/route.js
//
// GET ?code=<code from /start> -> { status: "pending" | "denied" | "expired" } or, once the person confirmed in Telegram,
// { status: "ready", token, subject, name, expiresAt } -- the session token is handed out exactly once.

import { NextResponse } from "next/server";
import { pollTelegramLogin } from "../../../../../lib/watcherTelegram.js";
import { slidingWindowCheck, getClientIp } from "../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const limit = await slidingWindowCheck({ action: "watcher:telegram-poll", key: getClientIp(req), max: 600, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    const code = new URL(req.url).searchParams.get("code");
    return NextResponse.json(await pollTelegramLogin(code), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("watcher/telegram/poll failed:", err);
    return NextResponse.json({ error: "Could not check sign-in." }, { status: 500 });
  }
}
