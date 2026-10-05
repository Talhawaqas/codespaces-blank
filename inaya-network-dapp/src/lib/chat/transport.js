// src/lib/chat/transport.js
//
// Realtime delivery without WebSockets (the deployment is serverless). Three modes share one cheap "is there news?" check:
//   * plain polling   -> GET /sync                       (always works)
//   * long polling    -> GET /sync?wait=20000            (holds the request up to LIMITS.longPollMaxMs)
//   * server-sent events -> GET /stream                  (holds for a bounded time, then the browser reconnects itself)
// All of them carry only "something changed" signals and metadata; encrypted payloads are fetched afterwards through the
// ordinary message routes, so the transport never sees plaintext. Events are ordered by per-conversation `seq`, clients
// replay from their last cursor after any reconnect, and duplicates are suppressed by seq.

import { LIMITS, chatDb, normEmail } from "./common.js";
import { getActiveDevice } from "./devices.js";
import { syncState } from "./conversations.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cheap check: any of my conversations updated after `since`, or an undelivered Welcome waiting for this device. */
export async function hasNewsSince({ orgId, email, deviceId, since }) {
  const em = normEmail(email);
  const { participants, conversations, envelopes } = await chatDb();
  if (await envelopes.countDocuments({ recipientDeviceId: deviceId, consumedAt: null }, { limit: 1 })) return true;
  const mine = await participants.find({ email: em, status: { $in: ["active", "pending", "left", "removed"] } }).project({ conversationId: 1 }).limit(300).toArray();
  if (!mine.length) return false;
  return (await conversations.countDocuments({ _id: { $in: mine.map((p) => p.conversationId) }, updatedAt: { $gt: since } }, { limit: 1 })) > 0;
}

/** Returns as soon as there is news, or after `waitMs` with whatever the current state is. */
export async function longPollSync({ orgId, email, deviceId, cursors = {}, since = null, waitMs = 0, intervalMs = 1500 }) {
  const wait = Math.min(Math.max(Number(waitMs) || 0, 0), LIMITS.longPollMaxMs);
  if (!(await getActiveDevice({ orgId, email, deviceId }))) return syncState({ orgId, email, deviceId, cursors }); // throws the right error
  const deadline = Date.now() + wait;
  if (since && wait) {
    while (Date.now() < deadline) {
      if (await hasNewsSince({ orgId, email, deviceId, since })) break;
      await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)));
    }
  }
  return syncState({ orgId, email, deviceId, cursors });
}

/** A bounded text/event-stream. Emits `news` when something changed and `ping` comments to keep proxies from closing it. */
export function eventStream({ orgId, email, deviceId, since, signal, maxMs = 25_000, intervalMs = 2000 }) {
  const enc = new TextEncoder();
  let cursorTime = since || new Date().toISOString();
  return new ReadableStream({
    async start(controller) {
      const end = Date.now() + maxMs;
      controller.enqueue(enc.encode(`retry: 3000\n: connected\n\n`));
      try {
        while (Date.now() < end && !signal?.aborted) {
          const probe = new Date().toISOString();
          if (await hasNewsSince({ orgId, email, deviceId, since: cursorTime })) { controller.enqueue(enc.encode(`event: news\ndata: ${JSON.stringify({ at: probe })}\n\n`)); cursorTime = probe; }
          else controller.enqueue(enc.encode(`: ping\n\n`));
          await sleep(intervalMs);
        }
      } catch { /* the client went away */ }
      try { controller.close(); } catch { /* already closed */ }
    },
  });
}
