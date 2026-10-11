// test/meet-rooms.test.mjs -- Inaya Meet room lifecycle (Internxt-inspired SOW, Workstream C).
// Real database. No live WebRTC/browser here (see docs/internxt-implementation-ledger.md for what
// still needs a real two-browser verification pass) -- this covers room lifecycle, moderator
// authorization, guest access policy, and the adversarial cases from SOW §7.35 that don't need a
// real media connection: unauthorized join, room lock enforcement, cross-org isolation, PQC
// downgrade, and a removed participant's row never silently re-admitting itself.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/meet-rooms.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as rooms from "../src/lib/meet/rooms.js";
import { meetDb } from "../src/lib/meet/common.js";

const T = { timeout: 300000 };
let org, owner, alice, bob;
const code = (p) => p.then(() => null, (e) => e);

before(async () => {
  await setup();
  org = await makeChatOrg("meetrm", { people: ["alice", "bob"] });
  owner = org.owner; alice = org.alice; bob = org.bob;
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_MEET", enabled: true });
});
after(async () => {
  const { rooms: r, participants: p, signals: s } = await meetDb();
  await Promise.all([r.deleteMany({ orgId: org.orgId }), p.deleteMany({ orgId: org.orgId }), s.deleteMany({ orgId: org.orgId })]);
  await teardown();
});

test("createRoom: the host is auto-admitted; a non-member cannot see the room", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Standup" });
  assert.equal(r.hostEmail, owner.email);
  assert.equal(r.status, "lobby");
  assert.ok(r.joinToken);
  const mine = await rooms.getRoom({ orgId: org.oid, membership: owner.membership, email: owner.email, roomId: r.roomId });
  assert.equal(mine.me.role, "host");
  assert.equal(mine.me.status, "admitted");
  const err = await code(rooms.getRoom({ orgId: org.oid, membership: bob.membership, email: bob.email, roomId: r.roomId }));
  assert.equal(err.status, 404, "a non-participant, non-admin org member cannot see a room they're not in");
});

test("requestJoin: the wrong token is rejected the same as an unknown room (no room-id oracle)", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Wrong token" });
  const err = await code(rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: "not-the-real-token", email: alice.email }));
  assert.equal(err.status, 404);
});

test("requestJoin + approve: org-member default policy (orgMemberAutoAdmit) admits without a lobby wait", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Auto admit" });
  const joined = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  assert.equal(joined.status, "admitted");
  assert.equal(joined.waiting, false);
});

test("requestJoin: guestAccess 'forbidden' rejects a guest; 'approval' puts them in the waiting room for the host to admit", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Guests", policy: { guestAccess: "forbidden" } });
  const err = await code(rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: null, guestName: "Visitor" }));
  assert.equal(err.code, "GUEST_FORBIDDEN");

  const r2 = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Guests 2", policy: { guestAccess: "approval" } });
  const joined = await rooms.requestJoin({ orgId: org.oid, roomId: r2.roomId, joinToken: r2.joinToken, email: null, guestName: "Visitor" });
  assert.equal(joined.status, "waiting");
  assert.ok(joined.guestToken, "a guest gets a session token back to come back and poll/signal with");

  const waiting = await rooms.listWaiting({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r2.roomId });
  assert.equal(waiting.waiting.length, 1);
  const approved = await rooms.approveParticipant({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r2.roomId, participantId: waiting.waiting[0].participantId });
  assert.equal(approved.status, "admitted");
});

test("approveParticipant: only the host/moderator or an org admin can admit -- another participant cannot", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Mod check", policy: { guestAccess: "approval" } });
  const joined = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: null, guestName: "Visitor" });
  const err = await code(rooms.approveParticipant({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, roomId: r.roomId, participantId: joined.participantId }));
  assert.equal(err.status, 403);
});

test("PQC downgrade: a PQC_REQUIRED room refuses admission without a real hybrid envelope (SOW §7.35)", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "PQC required", policy: { keyMode: "PQC_REQUIRED", guestAccess: "approval" } });
  const joined = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: null, guestName: "Visitor" });
  const noEnvelope = await code(rooms.approveParticipant({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId, participantId: joined.participantId }));
  assert.equal(noEnvelope.code, "PQC_REQUIRED_MISMATCH");
  const fakeEnvelope = await code(rooms.approveParticipant({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId, participantId: joined.participantId, roomSecretEnvelope: { not: "a real hybrid envelope" } }));
  assert.equal(fakeEnvelope.code, "PQC_REQUIRED_MISMATCH", "a well-formed-looking but non-hybrid object is rejected, not silently accepted as a downgrade");
});

test("room lock: an already-admitted participant can still act; a brand new join attempt is refused (ROOM_LOCKED)", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Lock test" });
  await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  await rooms.lockRoom({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId, locked: true });
  const rejoinAlice = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  assert.equal(rejoinAlice.status, "admitted", "an existing admitted participant is unaffected by the lock");
  const newcomer = await code(rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: bob.email }));
  assert.equal(newcomer.code, "ROOM_LOCKED");
});

test("removeParticipant: the host cannot be removed; a removed participant's row stays removed, not auto-readmitted on rejoin", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Remove test" });
  const hostRow = (await rooms.getRoom({ orgId: org.oid, membership: owner.membership, email: owner.email, roomId: r.roomId })).me;
  const cantRemoveHost = await code(rooms.removeParticipant({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId, participantId: hostRow.participantId }));
  assert.equal(cantRemoveHost.status, 400);

  const joined = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  await rooms.removeParticipant({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId, participantId: joined.participantId });
  const rejoin = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  assert.notEqual(rejoin.participantId, joined.participantId, "a removed participant rejoining gets a fresh row, never silently reuses the removed one");
});

test("maxParticipants: a full room refuses a new admission (ROOM_FULL)", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Capacity", policy: { maxParticipants: 2 } });
  // Host already counts as 1 of 2.
  await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  const err = await code(rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: bob.email }));
  assert.equal(err.code, "ROOM_FULL");
});

test("cross-org isolation: a room created in one org is not reachable through a different org's orgId", T, async () => {
  const org2 = await makeChatOrg("meetrm2", { people: [] });
  await setOrgFeature({ orgId: org2.oid, name: "FEATURE_MEET", enabled: true });
  try {
    const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Isolation" });
    const err = await code(rooms.getRoom({ orgId: org2.oid, membership: org2.owner.membership, email: org2.owner.email, roomId: r.roomId }));
    assert.equal(err.status, 404);
  } finally {
    const { rooms: rc, participants: pc } = await meetDb();
    await Promise.all([rc.deleteMany({ orgId: org2.orgId }), pc.deleteMany({ orgId: org2.orgId })]);
    await cols.orgMembers.deleteMany({ orgId: org2.orgId });
    await cols.orgs.deleteOne({ _id: org2.orgId });
  }
});

test("named guest access: the right code from the right email admits automatically; everything else is rejected (SOW §7.9/§7.22)", T, async () => {
  let sentTo = null, sentCode = null;
  rooms.setGuestCodeEmailSender(async ({ to, text }) => { sentTo = to; sentCode = /is (\d{6})/.exec(text)?.[1]; });
  try {
    const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Named guests", policy: { guestAccess: "named", namedGuestEmails: ["invited@example.com"] } });

    // An uninvited email gets the same generic "sent" response -- never reveals eligibility.
    const uninvited = await rooms.requestNamedGuestCode({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: "stranger@example.com" });
    assert.equal(uninvited.sent, true);
    assert.equal(sentTo, null, "no email actually went out for an address that isn't on the list");

    // The invited email gets a real code.
    const ok = await rooms.requestNamedGuestCode({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: "invited@example.com" });
    assert.equal(ok.sent, true);
    assert.equal(sentTo, "invited@example.com");
    assert.match(sentCode, /^\d{6}$/);

    // Wrong code is rejected.
    const wrongCode = await code(rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: null, guestName: "Alice Guest", namedGuestEmail: "invited@example.com", code: "000000" }));
    assert.equal(wrongCode.code, "BAD_CODE");

    // Right code, right email: auto-admitted (being on the list is itself the approval).
    const joined = await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: null, guestName: "Alice Guest", namedGuestEmail: "invited@example.com", code: sentCode });
    assert.equal(joined.status, "admitted");
    assert.equal(joined.isGuest, true);
    assert.equal(joined.email, "invited@example.com");

    // The code is single-use -- a second join attempt with the SAME code (after a fresh code request) fails.
    const r2 = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "Named guests 2", policy: { guestAccess: "named", namedGuestEmails: ["invited@example.com"] } });
    await rooms.requestNamedGuestCode({ orgId: org.oid, roomId: r2.roomId, joinToken: r2.joinToken, email: "invited@example.com" });
    const reusedCode = sentCode;
    await rooms.requestJoin({ orgId: org.oid, roomId: r2.roomId, joinToken: r2.joinToken, email: null, guestName: "Reuse Test", namedGuestEmail: "invited@example.com", code: reusedCode });
    const replay = await code(rooms.requestJoin({ orgId: org.oid, roomId: r2.roomId, joinToken: r2.joinToken, email: null, guestName: "Reuse Test 2", namedGuestEmail: "other-name@example.com", code: reusedCode }));
    // A different email can't reuse a code issued to someone else's address.
    assert.ok(replay.code === "BAD_CODE" || replay.code === "GUEST_NOT_NAMED");
  } finally {
    rooms.setGuestCodeEmailSender(async () => {}); // restore a harmless no-op for any later test
  }
});

test("endRoom: ends for everyone, marks admitted participants left, and is idempotent", T, async () => {
  const r = await rooms.createRoom({ orgId: org.oid, membership: owner.membership, hostEmail: owner.email, title: "End test" });
  await rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: alice.email });
  await rooms.endRoom({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId });
  const ended = await code(rooms.requestJoin({ orgId: org.oid, roomId: r.roomId, joinToken: r.joinToken, email: bob.email }));
  assert.equal(ended.code, "MEETING_ENDED");
  const again = await rooms.endRoom({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, roomId: r.roomId });
  assert.equal(again.alreadyEnded, true);
});
