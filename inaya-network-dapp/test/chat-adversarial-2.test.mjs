// test/chat-adversarial-2.test.mjs -- the two adversarial cases CHAT-019 listed as missing (forged read events, replay of old ciphertext by a removed participant)
// plus the legal-hold path check for GOV-004 (no destructive document route exists in the Business Workspace API). Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/chat-adversarial-2.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup, teardown, makeChatOrg, client } from "./_chat-fixtures.mjs";
import * as conv from "../src/lib/chat/conversations.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, A, B, id;
const me = (who) => ({ orgId: org.oid, email: who.email, conversationId: id });
before(async () => { await setup(); org = await makeChatOrg("adv2", { people: ["alice", "bob", "carol"] }); A = await client(org, org.alice, { label: "A" }); B = await client(org, org.bob, { label: "B" }); id = (await A.createConversation({ kind: "group", emails: [org.bob.email] })).conversationId; await B.sync(); await A.send(id, { text: "one" }); await A.send(id, { text: "two" }); await B.sync(); });
after(async () => { await teardown(); });

test("forged read events: a read position is clamped to what exists, belongs only to the caller, and outsiders and removed people cannot set one", T, async () => {
  const last = (await conv.markRead({ ...me(org.bob), seq: 1e9 })).readSeq; assert.ok(last >= 2 && last < 1e6, "a huge forged seq is clamped to the real last seq");
  assert.equal((await conv.markRead({ ...me(org.bob), seq: -5 })).readSeq, last, "a negative or lower value never moves the position back");
  assert.equal((await conv.markRead({ ...me(org.bob), seq: "abc" })).readSeq, last, "junk is treated as zero");
  const rec = await conv.readReceipts(me(org.alice)); const bobRow = JSON.stringify(rec); assert.ok(!/one|two/.test(bobRow), "receipts carry positions only, never text");
  assert.equal((await code(conv.markRead({ ...me(org.carol), seq: 2 }))).status, 404, "someone outside the conversation cannot set a read position");
  assert.equal((await code(conv.markRead({ orgId: org.oid, email: org.alice.email, conversationId: "0123456789abcdef01234567", seq: 2 }))).status, 404, "an unknown conversation id gives the same uniform answer");
});

test("a removed participant replaying old ciphertext: the server serves nothing after the removal point, refuses sends, and the removed device cannot read later messages", T, async () => {
  await conv.removeParticipant({ orgId: org.oid, membership: org.owner.membership, email: org.alice.email, conversationId: id, targetEmail: org.bob.email }); await A.sync(); await A.send(id, { text: "after bob was removed" }); await A.sync();
  const dev = B.device.deviceId; const { getOrgCollections } = await import("../src/lib/orgs.js"); const { db } = await getOrgCollections();
  const p = await db.collection("chat_participants").findOne({ conversationId: id, email: org.bob.email }); assert.equal(p.status, "removed");
  let served = null; const err = await code((async () => { served = await conv.listMessages({ orgId: org.oid, email: org.bob.email, deviceId: dev, conversationId: id, afterSeq: 0 }); })());
  if (!err) { const seqs = (served.messages || []).map((m) => m.seq); assert.ok(Math.max(0, ...seqs) <= p.removedAtSeq, "served seqs must not pass the removal point"); assert.equal(JSON.stringify(served).includes("after bob was removed"), false); } else assert.ok([403, 404].includes(err.status));
  const send = await code(conv.submitMessage({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email, deviceId: dev, conversationId: id, clientMsgId: "replay-attempt-0001", sub: "msg", ciphertext: Buffer.from("x".repeat(64)).toString("base64") })); assert.ok(send && [403, 404, 400].includes(send.status), "the removed person cannot send");
  await B.sync().catch(() => {}); assert.ok(!(await B.messages(id)).some((m) => m.text === "after bob was removed"), "the removed device never decrypts a later message");
});

test("GOV-004: the Business Workspace API has no destructive document route, so legal hold cannot be bypassed there (the only removal is a reversible archive transition)", T, () => {
  const root = path.join("src", "app", "api", "orgs", "documents");
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== "route.js") continue;
      const src = fs.readFileSync(p, "utf8");
      if (/export\s+async\s+function\s+(DELETE|PUT)/.test(src)) hits.push(p.split(path.sep).join("/"));
    }
  };
  walk(root);
  assert.deepEqual(hits, ["src/app/api/orgs/documents/[documentId]/permissions/route.js"], "the only DELETE under documents removes a permission grant, not a document");
  const wf = fs.readFileSync(path.join("src", "lib", "document-workflow.js"), "utf8");
  assert.ok(/archive:\s*\{[^}]*to:\s*"ARCHIVED"/.test(wf), "archive is a state change");
  assert.equal(/deletedAt/.test(wf), false, "the workflow never stamps a deletion");
});
