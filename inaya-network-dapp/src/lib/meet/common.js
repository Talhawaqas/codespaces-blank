// src/lib/meet/common.js
//
// Inaya Meet (Internxt-inspired SOW, Workstream C). Shared constants, errors and the collection
// accessor. Mirrors src/lib/chat/common.js's own shape -- Meet is a new, bounded feature, not a
// second chat engine, but it earns the same structure (common.js + rooms.js + signaling.js) chat
// already uses for the same reason: a lifecycle layer plus a transport layer are genuinely two
// different concerns. See docs/architecture/meet-architecture-adr.md for the full protocol.
//
// Nothing in src/lib/meet/** ever sees camera/mic/screen-share media or a meeting room secret in
// plaintext -- the room secret is generated and wrapped entirely on the host's device (the ADR's
// §5), and this layer only stores/relays the opaque wrapped envelope per participant.

import { randomBytes, createHash } from "node:crypto";
import { Pqc } from "@inaya-network/custody-sdk";
import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections, toObjectId } from "../orgs.js";

// Reused, not reinvented: the exact same LEGACY_CLASSICAL/HYBRID_PQC/PQC_REQUIRED enum the sharing
// primitive already uses (custody-sdk's Pqc.SHARING_MODE, PQC-A05) -- a meeting's key-establishment
// policy IS a sharing-mode decision (who the room secret gets wrapped for), not a new concept.
export const POLICY_KEY_MODES = Pqc.SHARING_MODE;
export const isPqcEnvelope = Pqc.isAgileHybridEnvelope;

export const LIMITS = {
  maxParticipantsDefault: 6, // SOW §1.5: Internxt's own docs are inconsistent (4/5/10) -- a configurable, honestly-scoped default, never a copied marketing number
  maxParticipantsCap: 24, // mesh topology's practical ceiling (see the ADR) -- policy may lower this, never raise it past the cap
  maxTitleLen: 140,
  joinTokenBytes: 24,
  guestTokenBytes: 24,
  guestNameLen: 80,
  namedGuestEmailsMax: 100,
  roomsPerOrgHour: 60,
  joinAttemptsPerMinute: 20,
  signalPayloadBytes: 16 * 1024, // one SDP blob or a batch of ICE candidates -- generous but bounded
  signalsPerMinute: 600, // ICE trickle can be chatty; still bounded against abuse
  longPollMaxMs: 25_000,
  roomSecretEnvelopeBytes: 8 * 1024,
  scheduleWindowDays: 90,
};

export const GUEST_ACCESS_MODES = ["forbidden", "allowed", "approval", "named"];
export const ROOM_STATUSES = ["scheduled", "lobby", "active", "locked", "ended"];
export const PARTICIPANT_STATUSES = ["waiting", "admitted", "rejected", "left", "removed"];

export class MeetError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
export const fail = (status, message, code) => { throw new MeetError(status, message, code); };
export const nowIso = () => new Date().toISOString();
export const normEmail = (e) => String(e || "").trim().toLowerCase();

export const newToken = (bytes) => randomBytes(bytes).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(String(token), "utf8").digest("hex");

let indexed = false;
/** All Meet collections, with indexes created once per process. */
export async function meetDb() {
  const { db } = await connectToDatabase();
  const c = {
    db,
    rooms: db.collection("meet_rooms"),
    participants: db.collection("meet_participants"),
    signals: db.collection("meet_signals"),
  };
  if (!indexed) {
    await Promise.all([
      c.rooms.createIndex({ orgId: 1, status: 1, updatedAt: -1 }),
      c.rooms.createIndex({ joinTokenHash: 1 }, { unique: true, partialFilterExpression: { joinTokenHash: { $type: "string" } } }),
      c.rooms.createIndex({ orgId: 1, hostEmail: 1, status: 1 }),
      c.participants.createIndex({ roomId: 1, status: 1 }),
      c.participants.createIndex({ roomId: 1, email: 1 }, { partialFilterExpression: { email: { $type: "string" } } }),
      c.participants.createIndex({ guestTokenHash: 1 }, { partialFilterExpression: { guestTokenHash: { $type: "string" } } }),
      c.signals.createIndex({ roomId: 1, seq: 1 }),
      c.signals.createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 }), // signaling is ephemeral by nature; nothing here needs to outlive the meeting
    ]);
    indexed = true;
  }
  return c;
}

export { getOrgCollections, toObjectId };
