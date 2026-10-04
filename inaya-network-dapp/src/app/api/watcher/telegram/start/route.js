// app/api/watcher/telegram/start/route.js
//
// GET  -> { enabled } so the app can decide whether to show "Continue with Telegram" (no secrets, no side effects).
// POST -> starts a Telegram sign-in: { code, url, expiresAt }. The app opens `url` in Telegram and then polls /api/watcher/telegram/poll?code=.
// Rate limited per caller IP: each start is a database write.

import { NextResponse } from "next/server";
import { telegramEnabled, startTelegramLogin } from "../../../../../lib/watcherTelegram.js";
import { slidingWindowCheck, getClientIp } from "../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ enabled: telegramEnabled() });
}

export async function POST(req) {
  try {
    if (!telegramEnabled()) return NextResponse.json({ error: "Telegram sign-in isn't available yet." }, { status: 503 });
    const limit = await slidingWindowCheck({ action: "watcher:telegram-start", key: getClientIp(req), max: 20, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Too many sign-in attempts. Please wait a few minutes and try again." }, { status: 429 });
    return NextResponse.json(await startTelegramLogin());
  } catch (err) {
    console.error("watcher/telegram/start failed:", err);
    return NextResponse.json({ error: "Could not start Telegram sign-in." }, { status: err.status || 500 });
  }
}
