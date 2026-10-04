// scripts/telegram-setup.mjs -- one-time setup of the Watcher Pioneer Telegram bot's webhook. Run it yourself: it needs the bot token.
//
//   1. In Telegram, talk to @BotFather: /newbot (or use an existing bot). Copy the token it gives you and the bot's username.
//   2. Set these on the server (Vercel > Project > Settings > Environment Variables, Production):
//        TELEGRAM_BOT_TOKEN       the token from BotFather (a secret: never commit it)
//        TELEGRAM_BOT_USERNAME    the bot's username, e.g. InayaWatcherBot
//        TELEGRAM_GROUP_CHAT      optional, e.g. @inayanetwork. To VERIFY group membership, add the bot to that group as an administrator.
//   3. Redeploy, then run this once from this folder with the same values in your shell:
//        TELEGRAM_BOT_TOKEN=... node scripts/telegram-setup.mjs https://www.inayanetwork.com
//
// It points the bot at <site>/api/watcher/telegram/webhook and sets the secret Telegram must send back. Re-running it is safe.

import crypto from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN;
const site = (process.argv[2] || "").replace(/\/+$/, "");
if (!token || !/^https:\/\//.test(site)) { console.error("Usage: TELEGRAM_BOT_TOKEN=<token> node scripts/telegram-setup.mjs https://<your site>"); process.exit(1); }

// must match webhookSecret() in src/lib/watcherTelegram.js
const secret = crypto.createHmac("sha256", token).update("inaya-watcher-webhook").digest("hex");
const call = async (method, body) => { const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); const j = await r.json(); if (!j.ok) throw new Error(`${method}: ${j.description}`); return j.result; };

const me = await call("getMe");
console.log(`Bot: @${me.username} (${me.first_name})`);
await call("setWebhook", { url: `${site}/api/watcher/telegram/webhook`, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
const info = await call("getWebhookInfo");
console.log(`Webhook set: ${info.url}  pending=${info.pending_update_count}  lastError=${info.last_error_message || "none"}`);
if (process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "") !== me.username) console.warn(`Warning: TELEGRAM_BOT_USERNAME (${process.env.TELEGRAM_BOT_USERNAME}) is not this bot (@${me.username}).`);
