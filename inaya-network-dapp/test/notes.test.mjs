// test/notes.test.mjs -- Secure Notes end to end: the real NotesClient (real WebCrypto) talking to the real route handlers over the real database.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/notes.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { SESSION_COOKIE, getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { NotesClient, ConflictError, KeyChangedError } from "../src/lib/notes/client/NotesClient.js";
import { purgeTrashedNotes } from "../src/lib/notes/notes.js";

const mod = {}; const load = async (p) => (mod[p] ||= await import(p));
const PASS = "correct horse battery";
let org, other, db;

const FILES = { "": "route.js", "vault": "vault/route.js", "index": "index/route.js", "people": "people/route.js" };
function routeFor(path) { // "/vault", "/", "/<id>", "/<id>/revisions"
  const [p] = path.split("?"); const parts = p.split("/").filter(Boolean);
  if (parts.length === 0) return ["../src/app/api/orgs/notes/route.js", {}];
  if (parts.length === 1 && FILES[parts[0]]) return [`../src/app/api/orgs/notes/${FILES[parts[0]]}`, {}];
  if (parts.length === 1) return ["../src/app/api/orgs/notes/[noteId]/route.js", { noteId: parts[0] }];
  return ["../src/app/api/orgs/notes/[noteId]/revisions/route.js", { noteId: parts[0] }];
}
function apiFor(cookie, orgId) {
  return async (method, path, body) => {
    const [file, params] = routeFor(path); const m = await load(file);
    const url = new URL("http://localhost/x" + (path.includes("?") ? "?" + path.split("?")[1] : "")); url.searchParams.set("orgId", orgId);
    const res = await m[method](new NextRequest(url, { method, headers: { host: "localhost", cookie: `${SESSION_COOKIE}=${cookie}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve(params) });
    const data = await res.json().catch(() => ({}));
    if (res.status >= 400) throw Object.assign(new Error(data.error || "HTTP " + res.status), { status: res.status, data });
    return data;
  };
}
const client = async (who, orgObj = org, { setupVault = true } = {}) => {
  const cookie = await cookieFor(who.email); const cl = new NotesClient({ api: apiFor(cookie, orgObj.oid), email: who.email });
  if (setupVault) { if (await cl.hasVault()) await cl.unlock(PASS); else await cl.setup(PASS); } return cl;
};
const rejects = async (p, status, code) => { try { await p; } catch (e) { assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`); if (code) assert.equal(e.data?.code, code); return e; } assert.fail("expected a rejection"); };

before(async () => {
  await setup(); db = (await getOrgCollections()).db;
  org = await makeChatOrg("notes", { people: ["alice", "bob", "carol", "dave"] }); other = await makeChatOrg("notes-other", { people: ["eve"] });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_NOTES", enabled: true }); await setOrgFeature({ orgId: other.oid, name: "FEATURE_SECURE_NOTES", enabled: true });
});
after(async () => { try { for (const n of await db.collection("notes").find({ orgId: { $in: [org.oid, other.oid] } }).toArray()) { await db.collection("note_revisions").deleteMany({ noteId: String(n._id) }); await db.collection("note_keys").deleteMany({ noteId: String(n._id) }); } await db.collection("notes").deleteMany({ orgId: { $in: [org.oid, other.oid] } }); await db.collection("note_vaults").deleteMany({ orgId: { $in: [org.oid, other.oid] } }); } catch { /* best effort */ } await teardown(); });

const T = { timeout: 300000 };

test("vault: passphrase opens it, a wrong one does not, changing it keeps your notes; the server holds no plaintext", T, async () => {
  const a = await client(org.alice); a.lock();
  await assert.rejects(a.unlock("totally wrong phrase"), (e) => e.code === "BAD_PASSPHRASE");
  await a.unlock(PASS); assert.ok(a.unlocked);
  const { noteId } = await a.create({ type: "text", title: "Payroll SECRET-TITLE", body: "salary SECRET-BODY" });
  const raw = JSON.stringify(await db.collection("note_revisions").find({ noteId }).toArray()) + JSON.stringify(await db.collection("note_vaults").find({ orgId: org.oid }).toArray());
  assert.ok(!raw.includes("SECRET-TITLE") && !raw.includes("SECRET-BODY"), "plaintext reached the database");
  await a.changePassphrase(PASS, "a brand new passphrase"); a.lock();
  await assert.rejects(a.unlock(PASS), (e) => e.code === "BAD_PASSPHRASE");
  await a.unlock("a brand new passphrase"); const list = await a.list(); assert.equal(list.find((n) => n.noteId === noteId).payload.title, "Payroll SECRET-TITLE");
  await a.changePassphrase("a brand new passphrase", PASS);
  await rejects(new NotesClient({ api: apiFor(await cookieFor(org.alice.email), org.oid), email: org.alice.email }).setup(PASS), 409);
});

test("note types and lifecycle: create, list, edit, history, restore a version; revisions are bound to their position", T, async () => {
  const a = await client(org.bob);
  const made = {};
  for (const [type, extra] of [["text", {}], ["rich", { body: "<p><b>bold</b></p>" }], ["markdown", { body: "# Title\n- a" }], ["checklist", { items: [{ id: "1", text: "buy", done: false }, { id: "2", text: "sell", done: true }] }], ["code", { body: "const x = 1;", lang: "js" }]])
    made[type] = await a.create({ type, title: `a ${type} note`, body: "hello", ...extra });
  const list = await a.list(); assert.equal(list.length, 5);
  assert.deepEqual(list.find((n) => n.payload.type === "checklist").payload.items.map((i) => i.done), [false, true]);
  assert.equal(list.find((n) => n.payload.type === "code").payload.lang, "js");

  const m = await a.open(made.text.noteId);
  await a.save(m, { ...m.payload, title: "renamed", body: "v2" });
  const m2 = await a.open(made.text.noteId); await a.save(m2, { ...m2.payload, body: "v3" });
  const h = await a.history(made.text.noteId); assert.equal(h.revisions.length, 3); assert.equal(h.current, 3);
  const m3 = await a.open(made.text.noteId); assert.equal(m3.payload.body, "v3");
  await a.restoreRevision(m3, 1);
  const m4 = await a.open(made.text.noteId); assert.equal(m4.rev, 4); assert.equal(m4.payload.title, "a text note"); assert.equal((await a.history(made.text.noteId)).revisions.length, 4, "history is append-only");

  // the server cannot present revision 1's ciphertext as revision 2: the AAD (noteId:rev:keyVersion) no longer matches
  const r1 = await db.collection("note_revisions").findOne({ noteId: made.text.noteId, rev: 1 });
  await db.collection("note_revisions").updateOne({ noteId: made.text.noteId, rev: 2 }, { $set: { iv: r1.iv, ct: r1.ct } });
  await assert.rejects(a.revisionPayload(m4, 2), (e) => e.code === "BAD_REVISION");
});

test("conflicts are explicit: a stale save is refused with the newer version, nothing is overwritten", T, async () => {
  const a = await client(org.carol); const { noteId } = await a.create({ type: "text", title: "shared plan", body: "base" });
  const s1 = await a.open(noteId); const s2 = await a.open(noteId);
  await a.save(s1, { ...s1.payload, body: "first writer" });
  const err = await a.save(s2, { ...s2.payload, body: "second writer" }).catch((e) => e);
  assert.ok(err instanceof ConflictError); assert.equal(err.latest.payload.body, "first writer"); assert.equal(err.latest.rev, 2);
  assert.equal((await a.open(noteId)).payload.body, "first writer");
  await a.save(await a.open(noteId), { ...err.latest.payload, body: "merged: first writer + second writer" }); // the user resolves it deliberately
  assert.equal((await a.open(noteId)).rev, 3);
});

test("sharing: key sealed per person, read vs write enforced, no vault / non-member / other org refused", T, async () => {
  const alice = await client(org.alice); const bob = await client(org.bob, org, { setupVault: false });
  await bob.unlock(PASS).catch(async () => bob.setup(PASS)); // bob already has a vault from the lifecycle test (same passphrase)
  const { noteId } = await alice.create({ type: "markdown", title: "Q3 plan", body: "launch in May" });
  const meta = await alice.open(noteId);
  await alice.share(meta, org.bob.email, "read");
  const seen = await bob.open(noteId); assert.equal(seen.payload.title, "Q3 plan"); assert.equal(seen.perm, "read");
  assert.equal((await bob.list()).some((n) => n.noteId === noteId), true);
  await rejects(bob.save(seen, { ...seen.payload, body: "bob edit" }), 403);
  await alice.setPermission(noteId, org.bob.email, "write");
  const seen2 = await bob.open(noteId); await bob.save(seen2, { ...seen2.payload, body: "bob edit" });
  assert.equal((await alice.open(noteId)).payload.body, "bob edit"); assert.equal((await alice.open(noteId)).lastEditedBy, org.bob.email.toLowerCase());

  await assert.rejects(alice.share(meta, org.dave.email, "read"), (e) => e.code === "NO_VAULT"); // dave has not set up Secure Notes yet
  const dave = await client(org.dave); // dave sets up a vault but is then not shared with: cannot read
  await rejects(dave.api("GET", `/${noteId}`), 404);
  const eve = await client(other.owner, other); await rejects(eve.api("GET", `/${noteId}`), 404);
  await rejects(alice.api("POST", `/${noteId}`, { action: "share", targetEmail: other.owner.email, perm: "read", keys: {} }), 404); // not a member of this org
  await rejects(bob.api("POST", `/${noteId}`, { action: "share", targetEmail: org.dave.email, perm: "read", keys: {} }), 403); // only the owner shares
  await rejects(bob.api("POST", `/${noteId}`, { action: "trash" }), 403);
});

test("removal rotates the key: the removed person is out, new revisions are unreadable with the old key, the rest carry on", T, async () => {
  const alice = await client(org.alice, org, { setupVault: false }); await alice.unlock(PASS);
  const bob = await client(org.bob, org, { setupVault: false }); await bob.unlock(PASS);
  const carol = await client(org.carol, org, { setupVault: false }); await carol.unlock(PASS);
  const { noteId } = await alice.create({ type: "text", title: "rotation", body: "before" });
  let meta = await alice.open(noteId); await alice.share(meta, org.bob.email, "write"); await alice.share(meta, org.carol.email, "read");
  const bobsOldKey = await bob.noteKey(noteId, 1, (await bob.open(noteId)).keys);
  meta = await alice.open(noteId); const r = await alice.removePerson(meta, org.bob.email);
  assert.equal(r.keyVersion, 2);
  await rejects(bob.api("GET", `/${noteId}`), 404);
  assert.equal(await db.collection("note_keys").countDocuments({ noteId, email: org.bob.email.toLowerCase() }), 0);
  const after = await alice.open(noteId); assert.equal(after.keyVersion, 2); assert.equal(after.payload.body, "before");
  assert.equal((await carol.open(noteId)).payload.body, "before");
  const latest = await db.collection("note_revisions").findOne({ noteId, rev: after.rev });
  const { decryptRevision } = await import("../src/lib/notes/client/crypto.js");
  await assert.rejects(decryptRevision(bobsOldKey, latest, { noteId, rev: latest.rev, keyVersion: 2 }), (e) => e.code === "BAD_REVISION");
  await alice.save(after, { ...after.payload, body: "after removal" });
  const logs = await cols.orgActivity.find({ orgId: org.orgId, recordType: "NOTE" }).toArray(); assert.ok(logs.some((l) => l.action === "UNSHARED"));
  assert.ok(!JSON.stringify(logs).includes("after removal"), "the audit trail never holds content");
});

test("leaving sets rotationDue and the owner's next open rotates the key", T, async () => {
  const alice = await client(org.alice, org, { setupVault: false }); await alice.unlock(PASS);
  const carol = await client(org.carol, org, { setupVault: false }); await carol.unlock(PASS);
  const { noteId } = await alice.create({ type: "text", title: "leave me", body: "x" });
  await alice.share(await alice.open(noteId), org.carol.email, "read");
  await carol.leave(noteId); await rejects(carol.api("GET", `/${noteId}`), 404);
  const m = await alice.open(noteId); assert.equal(m.rotationDue, true);
  assert.equal(await alice.rotateIfDue(m), true);
  const m2 = await alice.open(noteId); assert.equal(m2.rotationDue, false); assert.equal(m2.keyVersion, 2); assert.equal(m2.payload.body, "x");
  await rejects(alice.leave(noteId), 400);
});

test("trash, restore, permanent delete and retention purge", T, async () => {
  const alice = await client(org.alice, org, { setupVault: false }); await alice.unlock(PASS);
  const bob = await client(org.bob, org, { setupVault: false }); await bob.unlock(PASS);
  const { noteId } = await alice.create({ type: "text", title: "bin", body: "x" }); await alice.share(await alice.open(noteId), org.bob.email, "read");
  await rejects(alice.deletePermanently(noteId), 409);
  await alice.trash(noteId);
  assert.equal((await alice.list()).some((n) => n.noteId === noteId), false); assert.equal((await alice.list("trashed")).some((n) => n.noteId === noteId), true);
  assert.equal((await bob.list()).some((n) => n.noteId === noteId), false); await rejects(bob.api("GET", `/${noteId}`), 404);
  await alice.restore(noteId); assert.equal((await alice.list()).some((n) => n.noteId === noteId), true);
  await alice.trash(noteId);
  await db.collection("notes").updateOne({ _id: new ObjectId(noteId) }, { $set: { trashedAt: new Date(Date.now() - 31 * 86400_000).toISOString() } });
  const p = await purgeTrashedNotes(); assert.ok(p.purged >= 1);
  assert.equal(await db.collection("note_revisions").countDocuments({ noteId }), 0); assert.equal(await db.collection("note_keys").countDocuments({ noteId }), 0);
  const { noteId: n2 } = await alice.create({ type: "text", title: "bin2", body: "x" }); await alice.trash(n2); await alice.deletePermanently(n2);
  assert.equal(await db.collection("notes").countDocuments({ _id: new ObjectId(n2) }), 0);
});

test("private organization (pins, favorites, archive, tags) lives in the encrypted index and survives a second device", T, async () => {
  const a1 = await client(org.dave, org, { setupVault: false }); await a1.unlock(PASS).catch(async () => a1.setup(PASS));
  const { noteId } = await a1.create({ type: "text", title: "tagged", body: "x" });
  await a1.pin(noteId); await a1.favorite(noteId); const t = await a1.createTag("Finance"); await a1.tagNote(noteId, t); await a1.renameTag(t, "Money"); await a1.archive(noteId);
  const a2 = new NotesClient({ api: apiFor(await cookieFor(org.dave.email), org.oid), email: org.dave.email }); await a2.unlock(PASS); // a fresh device
  assert.deepEqual([a2.index.pins, a2.index.favorites, a2.index.archived], [[noteId], [noteId], [noteId]]); assert.equal(a2.index.tags[t].name, "Money"); assert.deepEqual(a2.index.noteTags[noteId], [t]);
  // two devices editing the index at once: the second retries on the compare-and-set conflict instead of losing either change
  await Promise.all([a1.createTag("Legal"), a2.createTag("Ops")]);
  const a3 = new NotesClient({ api: apiFor(await cookieFor(org.dave.email), org.oid), email: org.dave.email }); await a3.unlock(PASS);
  assert.deepEqual(Object.values(a3.index.tags).map((x) => x.name).sort(), ["Legal", "Money", "Ops"]);
  await a1.deleteTag(t); assert.equal(Object.keys(a1.index.tags).includes(t), false); assert.deepEqual(a1.index.noteTags[noteId], []);
  const raw = JSON.stringify(await db.collection("note_vaults").find({ orgId: org.oid }).toArray()); assert.ok(!raw.includes("Finance") && !raw.includes("Money"), "tag names are not readable by the server");
});

test("a changed public key is caught: first use is pinned, a later change is refused until accepted", T, async () => {
  const alice = await client(org.alice, org, { setupVault: false }); await alice.unlock(PASS);
  const n1 = await alice.create({ type: "text", title: "pin1", body: "x" }); const n2 = await alice.create({ type: "text", title: "pin2", body: "y" });
  const r = await alice.share(await alice.open(n1.noteId), org.dave.email, "read"); assert.match(r.fingerprint, /^([0-9A-F]{4} ?){5}$/);
  const { generateKeyPairSync } = await import("node:crypto"); const kp = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  await db.collection("note_vaults").updateOne({ orgId: org.oid, email: org.dave.email.toLowerCase() }, { $set: { publicKeyJwk: { kty: "EC", crv: "P-256", x: kp.x, y: kp.y } } }); // a server swap
  await assert.rejects(alice.share(await alice.open(n2.noteId), org.dave.email, "read"), (e) => e instanceof KeyChangedError);
});

test("feature flag, authentication and input limits", T, async () => {
  const a = await client(org.alice, org, { setupVault: false });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_NOTES", enabled: false });
  const e = await rejects(a.api("GET", "/vault"), 404); assert.match(e.message, /not enabled|not available|turned on/i);
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_NOTES", enabled: true });
  await rejects(new NotesClient({ api: apiFor("bogus-session", org.oid), email: "x@example.com" }).api("GET", "/vault"), 401);
  await a.unlock(PASS);
  await rejects(a.api("POST", "/", { noteId: "short", keyEnvelope: {}, revision: {} }), 400);
  await rejects(a.api("POST", "/", { noteId: "a".repeat(24), keyEnvelope: { v: 1 }, revision: { iv: "x", ct: "y" } }), 400);
  await assert.rejects(a.create({ type: "text", title: "big", body: "x".repeat(70_000) }), (err) => err.code === "TOO_LARGE");
});
