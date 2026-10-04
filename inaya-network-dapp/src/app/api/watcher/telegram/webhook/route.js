// app/api/watcher/telegram/webhook/route.js
//
// Telegram calls this with every message sent to the Watcher bot (registered once with scripts/telegram-setup.mjs). Telegram includes the
// secret we gave it in X-Telegram-Bot-Api-Secret-Token; anything without it is rejected, so only Telegram can drive a sign-in.
// Always answers 200 for an authentic update, even if it could not be used: Telegram retries a failed webhook, and a retry would repeat the message.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { telegramEnabled, webhookSecret, handleTelegramUpdate } from "../../../../../lib/watcherTelegram.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  if (!telegramEnabled()) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const given = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") || "");
  const expected = Buffer.from(webhookSecret());
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try { await handleTelegramUpdate(await req.json()); }
  catch (err) { console.error("watcher/telegram/webhook handling failed:", err); }
  return NextResponse.json({ ok: true });
}
