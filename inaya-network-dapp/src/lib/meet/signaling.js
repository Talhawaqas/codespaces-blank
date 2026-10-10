// src/lib/meet/signaling.js
//
// Realtime signaling for Inaya Meet, over the SAME long-poll/SSE transport pattern Secure Chat's
// own real-time layer already uses (src/lib/chat/transport.js) -- not a second real-time transport,
// per the Meet ADR §2/§8 (no WebSocket server; Vercel serverless cannot hold a persistent
// connection). Carries only SDP offers/answers, ICE candidates and room-control events (mute
// request, participant-removed, meeting-ended, lock state) -- never media, never a meeting key,
// never chat plaintext (§7.24).

import { ObjectId } from "mongodb";
import { LIMITS, fail, nowIso, meetDb } from "./common.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIGNAL_KINDS = ["offer", "answer", "ice", "control"];

/** Resolves the caller's own admitted participant row -- the one authorization check every
 *  signaling call needs (never trust a client-supplied participantId alone). */
async function requireAdmitted({ roomId, participantId, email, guestToken }) {
  const { participants } = await meetDb();
  let _id; try { _id = new ObjectId(participantId); } catch { fail(401, "Not authorized."); }
  const p = await participants.findOne({ _id, roomId: new ObjectId(roomId), status: "admitted" });
  if (!p) fail(401, "Not authorized.", "NOT_ADMITTED");
  const ok = email ? p.email === String(email).trim().toLowerCase() : guestToken && p.guestTokenHash;
  if (!ok) fail(401, "Not authorized.");
  if (guestToken) {
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(String(guestToken), "utf8").digest("hex") !== p.guestTokenHash) fail(401, "Not authorized.");
  }
  return p;
}

export async function postSignal({ roomId, participantId, email, guestToken, kind, payload, toParticipantId = null }) {
  const p = await requireAdmitted({ roomId, participantId, email, guestToken });
  if (!SIGNAL_KINDS.includes(kind)) fail(400, `kind must be one of: ${SIGNAL_KINDS.join(", ")}.`);
  const size = JSON.stringify(payload ?? null).length;
  if (size > LIMITS.signalPayloadBytes) fail(400, "Signal payload is too large.");
  if (toParticipantId) {
    const { participants } = await meetDb();
    let toId; try { toId = new ObjectId(toParticipantId); } catch { fail(400, "toParticipantId is not valid."); }
    const target = await participants.findOne({ _id: toId, roomId: p.roomId, status: "admitted" });
    if (!target) fail(404, "That participant is not in this meeting.");
  }
  const { rooms, signals } = await meetDb();
  const room = await rooms.findOneAndUpdate({ _id: p.roomId }, { $inc: { signalSeq: 1 }, $set: { updatedAt: nowIso() } }, { returnDocument: "after" });
  const seq = room?.signalSeq || 1;
  const doc = { _id: new ObjectId(), roomId: p.roomId, orgId: p.orgId, fromParticipantId: p._id, toParticipantId: toParticipantId ? new ObjectId(toParticipantId) : null, kind, payload: payload ?? null, seq, createdAt: new Date() };
  await signals.insertOne(doc);
  return { seq };
}

/** Broadcasts a room-control event (mute request, participant-removed, meeting-ended, lock state)
 *  to every currently-admitted participant. Server-originated, not attributed to any one
 *  participant's fromParticipantId -- `null` there always means "the room itself", never spoofable
 *  by a client since postSignal() always sets fromParticipantId to the caller's own row. */
export async function broadcastControl({ roomId, orgId, action, data = {} }) {
  const { rooms, signals } = await meetDb();
  const room = await rooms.findOneAndUpdate({ _id: new ObjectId(roomId) }, { $inc: { signalSeq: 1 } }, { returnDocument: "after" });
  if (!room) return;
  await signals.insertOne({ _id: new ObjectId(), roomId: room._id, orgId: String(orgId), fromParticipantId: null, toParticipantId: null, kind: "control", payload: { action, ...data }, seq: room.signalSeq, createdAt: new Date() });
}

async function hasNewsSince({ roomId, since }) {
  const { signals } = await meetDb();
  return (await signals.countDocuments({ roomId: new ObjectId(roomId), createdAt: { $gt: since } }, { limit: 1 })) > 0;
}

export async function longPollSync({ roomId, participantId, email, guestToken, since = null, waitMs = 0, cursorSeq = 0, intervalMs = 1500 }) {
  const wait = Math.min(Math.max(Number(waitMs) || 0, 0), LIMITS.longPollMaxMs);
  await requireAdmitted({ roomId, participantId, email, guestToken });
  if (since && wait) {
    const deadline = Date.now() + wait; const sinceDate = new Date(since);
    while (Date.now() < deadline) { if (await hasNewsSince({ roomId, since: sinceDate })) break; await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0))); }
  }
  const { signals } = await meetDb();
  const rows = await signals.find({ roomId: new ObjectId(roomId), seq: { $gt: Number(cursorSeq) || 0 }, $or: [{ toParticipantId: null }, { toParticipantId: new ObjectId(participantId) }] }).sort({ seq: 1 }).limit(200).toArray();
  return { signals: rows.map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload, fromParticipantId: s.fromParticipantId ? String(s.fromParticipantId) : null, at: s.createdAt })), at: nowIso() };
}

export function eventStream({ roomId, participantId, email, guestToken, since, signal, maxMs = 25_000, intervalMs = 2000 }) {
  const enc = new TextEncoder();
  let cursorTime = since ? new Date(since) : new Date();
  return new ReadableStream({
    async start(controller) {
      try { await requireAdmitted({ roomId, participantId, email, guestToken }); } catch { try { controller.close(); } catch {} return; }
      const end = Date.now() + maxMs;
      controller.enqueue(enc.encode(`retry: 3000\n: connected\n\n`));
      try {
        while (Date.now() < end && !signal?.aborted) {
          const probe = new Date();
          if (await hasNewsSince({ roomId, since: cursorTime })) { controller.enqueue(enc.encode(`event: news\ndata: ${JSON.stringify({ at: probe.toISOString() })}\n\n`)); cursorTime = probe; }
          else controller.enqueue(enc.encode(`: ping\n\n`));
          await sleep(intervalMs);
        }
      } catch { /* the client went away */ }
      try { controller.close(); } catch { /* already closed */ }
    },
  });
}
