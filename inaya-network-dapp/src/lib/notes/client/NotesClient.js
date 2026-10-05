// src/lib/notes/client/NotesClient.js
//
// Secure Notes client: everything that touches plaintext lives here (browser or test). The server only ever gets ciphertext.
// `api(method, path, body)` is injected: path is relative to /api/orgs/notes (e.g. "/vault", "/<id>/revisions?rev=3"); it must resolve to the
// parsed JSON or throw an Error with `.status` and `.data` (the parsed error body).
//
// Plaintext payload of one revision (a full snapshot):  { v:1, type: text|rich|markdown|checklist|code, title, body, items?, lang? }
// Per-user private organization lives in the encrypted INDEX, not in the shared note: { pins, favorites, archived, tags:{id:{name}}, noteTags:{noteId:[tagId]}, keyPins:{email:fingerprint} }

import { NotesCryptoError, createVaultKeys, decryptIndex, decryptRevision, encryptIndex, encryptRevision, exportNoteKey, fingerprint, importNoteKey, newNoteId, newNoteKeyRaw, openNoteKey, openVault, rewrapVaultKeys, sealNoteKey } from "./crypto.js";

export const TYPES = ["text", "rich", "markdown", "checklist", "code"];
export class ConflictError extends Error { constructor(latest) { super("Someone saved a newer version first."); this.code = "CONFLICT"; this.latest = latest; } }
export class KeyChangedError extends Error { constructor(email, was, now) { super(`${email}'s key is different from the one you saw before.`); this.code = "KEY_CHANGED"; this.email = email; this.was = was; this.now = now; } }
export const emptyIndex = () => ({ v: 1, pins: [], favorites: [], archived: [], tags: {}, noteTags: {}, keyPins: {} });

export function normalizePayload(p) {
  const type = TYPES.includes(p?.type) ? p.type : "text";
  const out = { v: 1, type, title: String(p?.title ?? "").slice(0, 200), body: String(p?.body ?? "") };
  if (type === "checklist") out.items = (Array.isArray(p?.items) ? p.items : []).slice(0, 500).map((i, n) => ({ id: String(i?.id ?? n), text: String(i?.text ?? "").slice(0, 500), done: !!i?.done }));
  if (type === "code") out.lang = String(p?.lang ?? "").slice(0, 30);
  return out;
}

export class NotesClient {
  constructor({ api, email }) { this.api = api; this.email = String(email).toLowerCase(); this.session = null; this.vault = null; this.index = emptyIndex(); this.indexVersion = 0; this.keys = new Map(); }

  get unlocked() { return !!this.session; }
  lock() { this.session = null; this.keys.clear(); this.index = emptyIndex(); }

  async fetchVault() { this.vault = (await this.api("GET", "/vault")).vault; return this.vault; }
  async hasVault() { return !!(await this.fetchVault()); }

  async setup(passphrase) {
    const { vault, session } = await createVaultKeys(passphrase);
    await this.api("POST", "/vault", { vault });
    await this.fetchVault(); this.session = session; this.index = emptyIndex(); this.indexVersion = 0; return true;
  }
  async unlock(passphrase) {
    const v = this.vault || (await this.fetchVault());
    if (!v) throw new NotesCryptoError("Set up Secure Notes first.", "NO_VAULT");
    this.session = await openVault(v, passphrase);
    if (v.index?.version > 0) { this.index = { ...emptyIndex(), ...(await decryptIndex(this.session.vk, v.index, v.index.version)) }; this.indexVersion = v.index.version; }
    else { this.index = emptyIndex(); this.indexVersion = 0; }
    return true;
  }
  async changePassphrase(oldPassphrase, newPassphrase) {
    const v = await this.fetchVault();
    const next = await rewrapVaultKeys(v, oldPassphrase, newPassphrase);
    await this.api("PUT", "/vault", { vault: next, expectedRev: v.vaultRev }); await this.fetchVault(); return true;
  }

  // ----------------------------------------------------------------------------------------------- private index
  async updateIndex(mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = JSON.parse(JSON.stringify(this.index)); mutate(next);
      const blob = await encryptIndex(this.session.vk, next, this.indexVersion + 1);
      try { const r = await this.api("PUT", "/index", { expectedVersion: this.indexVersion, ...blob }); this.index = next; this.indexVersion = r.version; return next; }
      catch (e) {
        if (e.data?.code !== "INDEX_CONFLICT") throw e;
        const v = await this.fetchVault(); this.index = { ...emptyIndex(), ...(await decryptIndex(this.session.vk, v.index, v.index.version)) }; this.indexVersion = v.index.version;
      }
    }
    throw new Error("Your notes index keeps changing on another device. Try again.");
  }
  setFlag(list, noteId, on) { return this.updateIndex((ix) => { const s = new Set(ix[list]); on ? s.add(noteId) : s.delete(noteId); ix[list] = [...s]; }); }
  pin(noteId, on = true) { return this.setFlag("pins", noteId, on); }
  favorite(noteId, on = true) { return this.setFlag("favorites", noteId, on); }
  archive(noteId, on = true) { return this.setFlag("archived", noteId, on); }
  async createTag(name) {
    const clean = String(name || "").trim().slice(0, 40); if (!clean) throw new Error("Give the tag a name.");
    let id; await this.updateIndex((ix) => { if (Object.values(ix.tags).some((t) => t.name.toLowerCase() === clean.toLowerCase())) throw new Error("That tag already exists."); id = "t" + Math.random().toString(36).slice(2, 9); ix.tags[id] = { name: clean }; }); return id;
  }
  renameTag(id, name) { const clean = String(name || "").trim().slice(0, 40); return this.updateIndex((ix) => { if (!ix.tags[id]) throw new Error("No such tag."); ix.tags[id].name = clean; }); }
  deleteTag(id) { return this.updateIndex((ix) => { delete ix.tags[id]; for (const k of Object.keys(ix.noteTags)) ix.noteTags[k] = ix.noteTags[k].filter((t) => t !== id); }); }
  tagNote(noteId, tagId, on = true) { return this.updateIndex((ix) => { const s = new Set(ix.noteTags[noteId] || []); on ? s.add(tagId) : s.delete(tagId); ix.noteTags[noteId] = [...s]; }); }

  // -------------------------------------------------------------------------------------------------------- keys
  async noteKey(noteId, keyVersion, envelopes) {
    const id = `${noteId}:${keyVersion}`;
    if (!this.keys.has(id)) {
      const env = envelopes?.[keyVersion]; if (!env) throw new NotesCryptoError("You do not have this note's key.", "NO_NOTE_KEY");
      this.keys.set(id, await openNoteKey(this.session.privateKey, env, noteId, keyVersion, this.email));
    }
    return this.keys.get(id);
  }
  async #decrypt(meta, rev) {
    const key = await this.noteKey(meta.noteId, rev.keyVersion, meta.keys);
    return normalizePayload(await decryptRevision(key, rev, { noteId: meta.noteId, rev: rev.rev, keyVersion: rev.keyVersion }));
  }

  // -------------------------------------------------------------------------------------------------------- notes
  /** Notes you can open, decrypted. A note that cannot be opened is returned with `error` instead of a payload. */
  async list(state = "active") {
    const out = []; let before;
    do {
      const r = await this.api("GET", `/?state=${state}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      for (const m of r.notes) { try { out.push({ ...m, payload: await this.#decrypt(m, m.latest) }); } catch (e) { out.push({ ...m, payload: null, error: e.message }); } }
      before = r.nextBefore;
    } while (before);
    return out;
  }
  /** Open one note. If its newest version cannot be decrypted (damaged or altered) you still get the metadata, with payload null and `error`, so an earlier version can be restored. */
  async open(noteId) { const m = await this.api("GET", `/${noteId}`); try { return { ...m, payload: await this.#decrypt(m, m.latest) }; } catch (e) { return { ...m, payload: null, error: e.message }; } }
  meta(noteId) { return this.api("GET", `/${noteId}`); }

  async create(payload) {
    const p = normalizePayload(payload); const noteId = newNoteId(); const raw = newNoteKeyRaw();
    const key = await importNoteKey(raw); const envelope = await sealNoteKey(this.session.publicKeyJwk, raw, noteId, 1, this.email); raw.fill(0);
    const blob = await encryptRevision(key, p, { noteId, rev: 1, keyVersion: 1 });
    await this.api("POST", "/", { noteId, keyEnvelope: envelope, revision: blob });
    this.keys.set(`${noteId}:1`, key); return { noteId, rev: 1, keyVersion: 1 };
  }

  /** Save a new version. `base` is the note as you last loaded it ({noteId, rev, keyVersion}). Throws ConflictError with the newer payload; nothing is overwritten. */
  async save(base, payload) {
    const p = normalizePayload(payload); const rev = base.rev + 1;
    const key = await this.noteKey(base.noteId, base.keyVersion, base.keys);
    const blob = await encryptRevision(key, p, { noteId: base.noteId, rev, keyVersion: base.keyVersion });
    try { return await this.api("POST", `/${base.noteId}/revisions`, { baseRev: base.rev, keyVersion: base.keyVersion, ...blob }); }
    catch (e) {
      if (e.data?.code === "CONFLICT" && e.data.latest) { let theirs = null; try { theirs = await this.#decrypt(base, e.data.latest); } catch { /* shown as unreadable */ } throw Object.assign(new ConflictError({ rev: e.data.latest.rev, by: e.data.latest.by, at: e.data.latest.at, payload: theirs }), {}); }
      throw e;
    }
  }

  async history(noteId) { return (await this.api("GET", `/${noteId}/revisions`)); }
  async revisionPayload(meta, rev) { const r = await this.api("GET", `/${meta.noteId}/revisions?rev=${rev}`); return { ...r, payload: await this.#decrypt(meta, r) }; }
  /** Restoring never rewrites history: the old content becomes a NEW latest version. */
  async restoreRevision(meta, rev) { const old = await this.revisionPayload(meta, rev); return this.save(meta, old.payload); }

  // ---------------------------------------------------------------------------------------------------- sharing
  async people() { return this.api("GET", "/people"); }
  /** Share with a member. Pins their key on first use; refuses if it later changes unless `acceptKeyChange`. */
  async share(meta, targetEmail, perm = "read", { acceptKeyChange = false } = {}) {
    const target = String(targetEmail).toLowerCase(); const { people } = await this.people(); const person = people.find((x) => x.email === target);
    if (!person) throw Object.assign(new Error("That person has not set up Secure Notes yet."), { code: "NO_VAULT" });
    const fp = await fingerprint(person.publicKeyJwk); const pinned = this.index.keyPins[target];
    if (pinned && pinned !== fp && !acceptKeyChange) throw new KeyChangedError(target, pinned, fp);
    const keys = {};
    for (let v = 1; v <= meta.keyVersion; v++) { if (!meta.keys[v]) continue; const raw = await exportNoteKey(await this.noteKey(meta.noteId, v, meta.keys)); keys[v] = await sealNoteKey(person.publicKeyJwk, raw, meta.noteId, v, target); raw.fill(0); }
    await this.api("POST", `/${meta.noteId}`, { action: "share", targetEmail: target, perm, keys });
    if (pinned !== fp) await this.updateIndex((ix) => { ix.keyPins[target] = fp; });
    return { fingerprint: fp };
  }
  setPermission(noteId, targetEmail, perm) { return this.api("POST", `/${noteId}`, { action: "setPermission", targetEmail, perm }); }

  /** Owner: remove a person (or just rotate the key). New key sealed to everyone who remains; the next revision is encrypted under it. */
  async #rotation(meta, remainingEmails) {
    const { people } = await this.people(); const raw = newNoteKeyRaw(); const keyVersion = meta.keyVersion + 1; const keys = {};
    for (const e of remainingEmails) {
      const pub = e === this.email ? this.session.publicKeyJwk : people.find((x) => x.email === e)?.publicKeyJwk;
      if (!pub) throw new Error(`${e} no longer has a notes vault, so the key cannot be rotated for them.`);
      keys[e] = await sealNoteKey(pub, raw, meta.noteId, keyVersion, e);
    }
    const key = await importNoteKey(raw); raw.fill(0);
    const current = await this.#decrypt(meta, meta.latest);
    const blob = await encryptRevision(key, current, { noteId: meta.noteId, rev: meta.rev + 1, keyVersion });
    return { rotation: { baseRev: meta.rev, keys, ...blob }, key, keyVersion };
  }
  async removePerson(meta, targetEmail) {
    const t = String(targetEmail).toLowerCase(); const remaining = meta.participants.map((p) => p.email).filter((e) => e !== t);
    const { rotation, key, keyVersion } = await this.#rotation(meta, remaining);
    const r = await this.api("POST", `/${meta.noteId}`, { action: "remove", targetEmail: t, rotation }); this.keys.set(`${meta.noteId}:${keyVersion}`, key); return r;
  }
  async rotateIfDue(meta) {
    if (!meta.rotationDue || meta.ownerEmail !== this.email) return false;
    const { rotation, key, keyVersion } = await this.#rotation(meta, meta.participants.map((p) => p.email));
    await this.api("POST", `/${meta.noteId}`, { action: "rotate", rotation }); this.keys.set(`${meta.noteId}:${keyVersion}`, key); return true;
  }
  leave(noteId) { return this.api("POST", `/${noteId}`, { action: "leave" }); }
  trash(noteId) { return this.api("POST", `/${noteId}`, { action: "trash" }); }
  restore(noteId) { return this.api("POST", `/${noteId}`, { action: "restore" }); }
  deletePermanently(noteId) { return this.api("DELETE", `/${noteId}`); }
}
