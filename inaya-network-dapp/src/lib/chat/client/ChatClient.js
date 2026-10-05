// src/lib/chat/client/ChatClient.js
//
// One device's chat engine: enrolls the device, keeps MLS group state, creates and reconciles conversations, encrypts and
// decrypts, and keeps a local decrypted cache for display and search. It talks to the server only through `api` (HTTP in the
// apps, direct calls in tests) and keeps secrets only in `store` (sealed). See docs/architecture/e2ee-chat-key-management.md.

import * as M from "./mls.js";
import { uploadEncrypted, downloadDecrypted, inayaDocRef } from "./attachments.js";

const KP_TARGET = 30;
const KP_LOW = 10;
const te = new TextEncoder(); const td = new TextDecoder();
const rndHex = (n) => M.bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
const rndId = () => rndHex(12);
const clientMsgId = () => rndHex(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ChatClient {
  /**
   * @param api    server adapter (see httpApi.js / directApi.js)
   * @param store  sealed key-value store (stores.js)
   * @param opts   { orgId, email, label, platform, provider, jitterMs, onSecurityEvent }
   */
  constructor({ api, store, orgId, email, label = "Device", platform = "web", provider, jitterMs = 0, onSecurityEvent = () => {}, now = () => Date.now() }) {
    Object.assign(this, { api, store, orgId: String(orgId), email: String(email).trim().toLowerCase(), label, platform, provider, jitterMs, onSecurityEvent, now });
    this.device = null; this.pins = {}; this.rosters = {}; this._locks = new Map(); this.metrics = { decryptFailures: 0, rejectedCommits: 0, sent: 0, received: 0 };
    this.cfg = M.clientConfigFor(M.makeAuthService({ pin: (id, keyHex) => this._pin(id, keyHex) }));
  }

  // ------------------------------------------------------------------------------------------- plumbing

  async _pin(id, keyHex) {
    const known = this.pins[id.deviceId];
    if (known) return known === keyHex;
    this.pins[id.deviceId] = keyHex; this._pinsDirty = true; return true; // trust on first use
  }
  async _savePins() { if (this._pinsDirty) { await this.store.set("pins", this.pins); this._pinsDirty = false; } }

  _withLock(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.then(() => {}, () => {}).then(() => { if (this._locks.get(key) === tail) this._locks.delete(key); });
    this._locks.set(key, tail);
    return next;
  }

  async _state(convId) { const s = await this.store.get(`g:${convId}`); return s ? M.deserializeState(s, this.cfg) : null; }
  async _saveState(convId, st) { await this.store.set(`g:${convId}`, M.serializeState(st)); }
  async _cursor(convId) { return (await this.store.get(`cur:${convId}`)) ?? 0; }
  async _setCursor(convId, n) { await this.store.set(`cur:${convId}`, n); }
  async _msgs(convId) { return (await this.store.get(`msgs:${convId}`)) || []; }
  async _saveMsgs(convId, list) { await this.store.set(`msgs:${convId}`, list); }
  async _meta(convId) { return (await this.store.get(`meta:${convId}`)) || { title: null }; }
  async _saveMeta(convId, m) { await this.store.set(`meta:${convId}`, m); }

  // ------------------------------------------------------------------------------------------- device

  async init() {
    this.pins = (await this.store.get("pins")) || {};
    this.device = await this.store.get("device");
    if (this.device) this.api.setDevice?.(this.device.deviceId);
    this.kps = (await this.store.get("kps")) || {};
    if (!this.device) await this.ensureDevice();
    else this.replenishKeyPackages().catch(() => {}); // stock check runs in the background; the chat is usable at once
    return this.device;
  }

  async ensureDevice() {
    const enrolled = await this.api.enrollDevice({ label: this.label, platform: this.platform });
    const deviceId = enrolled.device.deviceId; const identity = enrolled.identity;
    const sig = await M.newSignatureKeys();
    this.device = { deviceId, identity, sigPriv: M.toB64(sig.signKey), sigPub: M.bytesToHex(sig.publicKey), createdAt: new Date(this.now()).toISOString() };
    this.kps = {};
    await this.store.set("device", this.device);
    this.api.setDevice?.(deviceId);
    await this.store.set("kps", this.kps);
    await this.replenishKeyPackages({ initial: true });
    return this.device;
  }

  _sigKeys() { return { signKey: M.fromB64(this.device.sigPriv), publicKey: M.hexToBytes(this.device.sigPub) }; }

  async replenishKeyPackages({ initial = false } = {}) {
    const st = await this.api.keyPackageStatus({ deviceId: this.device.deviceId });
    const need = initial ? KP_TARGET : st.available < KP_LOW ? KP_TARGET - st.available : 0;
    const batch = []; const fresh = [];
    for (let i = 0; i < need; i++) { const kp = await M.makeKeyPackage({ identity: this.device.identity, sigKeys: this._sigKeys() }); fresh.push(kp); batch.push(M.toB64(kp.wire)); }
    if (batch.length) {
      await this.api.uploadKeyPackages({ deviceId: this.device.deviceId, packages: batch.slice(0, 50) });
      for (const kp of fresh.slice(0, 50)) this.kps[await this._ref(kp)] = { priv: M.packPrivate(kp.privatePackage), pub: M.toB64(kp.wire) };
    }
    if (initial || st.lastResort === 0) {
      const lr = await M.makeKeyPackage({ identity: this.device.identity, sigKeys: this._sigKeys(), lifetimeDays: 365 });
      await this.api.uploadKeyPackages({ deviceId: this.device.deviceId, packages: [M.toB64(lr.wire)], lastResort: true });
      this.kps[await this._ref(lr)] = { priv: M.packPrivate(lr.privatePackage), pub: M.toB64(lr.wire), lastResort: true };
    }
    await this.store.set("kps", this.kps);
  }

  async _ref(kp) {
    const impl = await M.getImpl({ provider: this.provider });
    const { makeKeyPackageRef } = await import("ts-mls/keyPackage.js");
    return M.bytesToHex(await makeKeyPackageRef(kp.publicPackage, impl.hash));
  }

  // ------------------------------------------------------------------------------------------- conversations

  async createConversation({ kind = "group", emails = [], external = false } = {}) {
    const conversationId = rndId();
    const res = await this.api.createConversation({ deviceId: this.device.deviceId, conversationId, kind, emails, external });
    if (res.existed) return { conversationId: res.conversation.id, existed: true };
    const kp = await M.makeKeyPackage({ identity: this.device.identity, sigKeys: this._sigKeys() });
    const st = await M.createGroupState({ groupIdHex: conversationId, kp, clientConfig: this.cfg });
    await this._saveState(conversationId, st);
    await this._setCursor(conversationId, 0);
    await this.reconcile(conversationId);
    return { conversationId, existed: false };
  }

  /** Execute the server's plan for this conversation (add pending people/devices, remove revoked/removed ones). */
  async reconcile(convId, opts = {}) { return this._withLock(convId, () => this._reconcileLocked(convId, opts)); }

  async _reconcileLocked(convId, { retries = 4 } = {}) {
    {
      for (let attempt = 0; attempt < retries; attempt++) {
        await this._pullLocked(convId);
        const detail = await this.api.conversationDetail({ deviceId: this.device.deviceId, conversationId: convId });
        this.rosters[convId] = detail.roster; await this.store.set(`roster:${convId}`, detail.roster);
        if (!detail.inGroup || (!detail.plan.adds.length && !detail.plan.removes.length)) return { epoch: detail.epoch, changed: false };
        if (this.jitterMs && attempt === 0) await sleep(Math.random() * this.jitterMs);
        let state = await this._state(convId);
        if (!state) return { changed: false };
        const ids = M.leafIdentities(state);

        // Sanity: the server's leaf map must equal the real tree, or we refuse to act on it.
        const removeLeaves = [];
        for (const r of detail.plan.removes) {
          const real = M.parseIdentity(ids.get(r.leafIndex));
          if (!real || real.deviceId !== r.deviceId) { this.onSecurityEvent({ type: "LEAF_MAP_DIVERGED", conversationId: convId }); throw new Error("The server's view of the group does not match the real group. Not acting."); }
          removeLeaves.push(r.leafIndex);
        }
        let adds = [];
        if (detail.plan.adds.length) {
          const claimed = await this.api.claimKeyPackages({ deviceId: this.device.deviceId, conversationId: convId, deviceIds: detail.plan.adds.map((a) => a.deviceId) });
          for (const c of claimed.packages) {
            const wire = M.fromB64(c.keyPackage);
            const m = (await import("ts-mls")).decodeMlsMessage(wire, 0)[0];
            const idn = M.parseIdentity(td.decode(m.keyPackage.leafNode.credential.identity));
            const want = detail.plan.adds.find((a) => a.deviceId === c.deviceId);
            if (!idn || !want || idn.deviceId !== c.deviceId || idn.email !== want.email) { this.onSecurityEvent({ type: "KEYPACKAGE_IDENTITY_MISMATCH", conversationId: convId }); continue; }
            if (!(await this.cfg.authService.validateCredential(m.keyPackage.leafNode.credential, m.keyPackage.leafNode.signaturePublicKey))) { this.onSecurityEvent({ type: "KEYPACKAGE_PIN_MISMATCH", conversationId: convId, deviceId: c.deviceId }); continue; }
            adds.push(wire);
          }
        }
        if (!adds.length && !removeLeaves.length) return { changed: false, blocked: detail.plan.adds.map((a) => a.deviceId) };
        const built = await M.buildCommit({ state, adds, removeLeaves });
        try {
          const r = await this.api.submitCommit({ deviceId: this.device.deviceId, conversationId: convId, baseEpoch: Number(state.groupContext.epoch), commit: M.toB64(built.commitWire), welcome: built.welcomeWire ? M.toB64(built.welcomeWire) : null, clientCommitId: clientMsgId() });
          await this._saveState(convId, built.newState);
          await this._savePins();
          if (adds.length) await this._announceMeta(convId, built.newState);
          return { changed: true, epoch: r.epoch, adds: r.adds, removes: r.removes };
        } catch (err) {
          if (err.code === "STALE_EPOCH" || err.status === 409) { await sleep(20 + Math.random() * 40); continue; }
          throw err;
        }
      }
      return { changed: false, gaveUp: true };
    }
  }

  /** After people join, tell them the title (they cannot read history). */
  async _announceMeta(convId) {
    const meta = await this._meta(convId);
    if (!meta.title) return;
    await this._sendLocked(convId, { sub: "meta", payload: { v: 1, t: "meta", title: meta.title } });
  }

  async addParticipants(convId, emails, { external = false } = {}) {
    await this.api.addParticipants({ conversationId: convId, emails, external });
    return this.reconcile(convId);
  }
  async removeParticipant(convId, email) {
    await this.api.removeParticipant({ conversationId: convId, targetEmail: email });
    return this.reconcile(convId);
  }
  async leave(convId) { await this.api.leaveConversation({ conversationId: convId }); await this.forget(convId); }
  async forget(convId) { for (const k of [`g:${convId}`, `cur:${convId}`, `msgs:${convId}`, `meta:${convId}`, `roster:${convId}`, `outbox:${convId}`]) await this.store.delete(k); }

  // ------------------------------------------------------------------------------------------- sync / receive

  /** Catch up on everything: Welcomes, then events of every conversation that moved. Returns what is new. */
  async sync({ wait = 0 } = {}) {
    const cursors = {};
    for (const k of await this.store.keys("cur:")) cursors[k.slice(4)] = await this.store.get(k);
    const res = await this.api.sync({ deviceId: this.device.deviceId, cursors, since: this._since || null, wait });
    this._since = res.serverTime;
    const fresh = [];
    for (const w of res.welcomes) await this._withLock(w.conversationId, () => this._acceptWelcome(w));
    for (const c of res.conversations) {
      if (c.status !== "active" && c.status !== "pending") continue;
      if (c.status === "pending") continue;
      if (!(await this._state(c.id))) continue; // not joined on this device yet
      const cur = await this._cursor(c.id);
      if (c.lastSeq > cur || c.updatedAt !== (await this.store.get(`upd:${c.id}`))) {
        const got = await this._withLock(c.id, () => this._pullLocked(c.id));
        fresh.push(...got);
        await this.store.set(`upd:${c.id}`, c.updatedAt);
        // someone's device may have joined or been revoked: let the plan run
        await this.reconcile(c.id).catch((e) => this.onSecurityEvent({ type: "RECONCILE_FAILED", conversationId: c.id, detail: e.message }));
      }
    }
    await this._savePins();
    await this._flushOutbox();
    // Stock check at most every 5 minutes, or right after a Welcome used up one of our KeyPackages.
    if (res.welcomes.length || !this._lastStock || this.now() - this._lastStock > 300000) { this._lastStock = this.now(); await this.replenishKeyPackages().catch(() => {}); }
    return { fresh, conversations: res.conversations };
  }

  async _acceptWelcome(w) {
    if (await this._state(w.conversationId)) { await this.api.ackWelcome({ deviceId: this.device.deviceId, conversationId: w.conversationId, epoch: w.epoch }); return; }
    const wire = M.fromB64(w.welcome);
    const msg = (await import("ts-mls")).decodeMlsMessage(wire, 0)[0];
    const refs = msg.welcome.secrets.map((s) => M.bytesToHex(s.newMember));
    const ref = refs.find((r) => this.kps[r]);
    if (!ref) { this.onSecurityEvent({ type: "WELCOME_NO_MATCHING_KEYPACKAGE", conversationId: w.conversationId }); return; }
    const kpRec = this.kps[ref];
    const m = (await import("ts-mls")).decodeMlsMessage(M.fromB64(kpRec.pub), 0)[0];
    const state = await M.joinFromWelcome({ welcomeWire: wire, kp: { publicPackage: m.keyPackage, privatePackage: M.unpackPrivate(kpRec.priv) }, clientConfig: this.cfg });
    await this._saveState(w.conversationId, state);
    await this._setCursor(w.conversationId, w.seq);
    if (!kpRec.lastResort) delete this.kps[ref];
    await this.store.set("kps", this.kps);
    await this._savePins();
    await this.api.ackWelcome({ deviceId: this.device.deviceId, conversationId: w.conversationId, epoch: w.epoch });
  }

  async pull(convId) { return this._withLock(convId, () => this._pullLocked(convId)); }

  async _pullLocked(convId) {
    let state = await this._state(convId); if (!state) return [];
    let cursor = await this._cursor(convId);
    const got = []; let msgs = null; let meta = null; let dirty = false;
    let roster = this.rosters[convId] || (await this.store.get(`roster:${convId}`)) || [];
    let rosterFresh = false;
    const freshRoster = async () => {
      if (rosterFresh) return roster;
      const d = await this.api.conversationDetail({ deviceId: this.device.deviceId, conversationId: convId }).catch(() => null);
      if (d) { roster = d.roster; this.rosters[convId] = roster; await this.store.set(`roster:${convId}`, roster); rosterFresh = true; }
      return roster;
    };
    for (;;) {
      const page = await this.api.listMessages({ deviceId: this.device.deviceId, conversationId: convId, afterSeq: cursor, limit: 100 });
      for (const ev of page.events) {
        if (ev.seq <= cursor) continue;
        if (ev.senderDeviceId === this.device.deviceId) { cursor = ev.seq; dirty = true; continue; } // own events: state already advanced when sent
        if (ev.kind === "commit") {
          if (!ev.commit) { cursor = ev.seq; continue; }
          rosterFresh = false; const rost = await freshRoster();
          const r = await M.processCommit({ state, commitWire: M.fromB64(ev.commit), policy: (inc) => this._commitPolicy(inc, state, rost) });
          if (!r.accepted) { this.metrics.rejectedCommits++; this.onSecurityEvent({ type: "COMMIT_REJECTED_BY_POLICY", conversationId: convId, seq: ev.seq }); } else state = r.newState;
          cursor = ev.seq; dirty = true; continue;
        }
        if (ev.purged || !ev.ciphertext) { cursor = ev.seq; dirty = true; continue; }
        try {
          const d = await M.decryptApplication({ state, wire: M.fromB64(ev.ciphertext) });
          state = d.newState;
          // The server's claim about the sender must equal the sender MLS authenticated.
          if (!d.senderIdentity || d.senderIdentity.email !== ev.senderEmail || d.senderIdentity.deviceId !== ev.senderDeviceId) {
            this.onSecurityEvent({ type: "SENDER_MISMATCH", conversationId: convId, seq: ev.seq }); cursor = ev.seq; dirty = true; continue;
          }
          let payload; try { payload = JSON.parse(td.decode(d.plaintext)); } catch { cursor = ev.seq; dirty = true; continue; }
          msgs ||= await this._msgs(convId); meta ||= await this._meta(convId);
          if (payload.t === "rename" || payload.t === "meta") await freshRoster();
          const applied = this._apply({ msgs, meta, ev, payload, roster, sender: d.senderIdentity });
          if (applied) got.push({ conversationId: convId, ...applied });
          this.metrics.received++;
        } catch (err) {
          this.metrics.decryptFailures++; this.onSecurityEvent({ type: "DECRYPT_FAILED", conversationId: convId, seq: ev.seq, detail: String(err?.message || err).slice(0, 80) });
        }
        cursor = ev.seq; dirty = true;
      }
      if (!page.hasMore) break;
    }
    if (dirty) { await this._saveState(convId, state); await this._setCursor(convId, cursor); if (msgs) await this._saveMsgs(convId, msgs); if (meta) await this._saveMeta(convId, meta); await this._savePins(); }
    return got;
  }

  /** Client-side authorization of someone else's commit (a malicious server cannot slip a rogue device in). */
  _commitPolicy(incoming, state, roster) {
    const status = new Map(roster.map((p) => [p.email, p]));
    const ids = M.leafIdentities(state);
    for (const pw of incoming.proposals) {
      const pr = pw.proposal;
      if (pr.proposalType === "add") {
        const idn = M.parseIdentity(td.decode(pr.add.keyPackage.leafNode.credential.identity));
        if (!idn || !status.has(idn.email)) return false;
      } else if (pr.proposalType === "remove") {
        const idn = M.parseIdentity(ids.get(Number(pr.remove.removed)));
        if (!idn) return false;
        const p = status.get(idn.email);
        const stillActive = p && (p.status === "active" || p.status === "pending") && p.deviceIds.includes(idn.deviceId);
        if (stillActive) return false; // removing a live device of a live participant is never legitimate
      } else return false;
    }
    return true;
  }

  _apply({ msgs, meta, ev, payload, roster, sender }) {
    const base = { seq: ev.seq, serverId: ev.id, at: ev.createdAt, from: ev.senderEmail };
    if (payload.t === "msg") {
      if (msgs.some((m) => m.serverId === ev.id)) return null;
      const m = { ...base, text: String(payload.text ?? ""), attachments: Array.isArray(payload.attachments) ? payload.attachments.slice(0, 20) : [], clientMsgId: payload.id || null, status: "received" };
      msgs.push(m); return { type: "msg", ...m };
    }
    if (payload.t === "edit" || payload.t === "del") {
      const target = msgs.find((m) => m.serverId === payload.target);
      if (!target || target.from !== ev.senderEmail) return null; // only the author may change a message
      if (payload.t === "edit") { target.text = String(payload.text ?? ""); target.editedAt = ev.createdAt; return { type: "edit", serverId: target.serverId, text: target.text, from: ev.senderEmail, seq: ev.seq }; }
      target.text = ""; target.attachments = []; target.deleted = true; return { type: "del", serverId: target.serverId, from: ev.senderEmail, seq: ev.seq };
    }
    if (payload.t === "rename" || payload.t === "meta") {
      const p = roster.find((r) => r.email === ev.senderEmail);
      if (!p || (p.role !== "owner" && p.role !== "admin" && roster.length > 2)) return null;
      meta.title = String(payload.title ?? "").slice(0, 120) || null; return { type: "title", title: meta.title, seq: ev.seq, from: ev.senderEmail };
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------- send

  async send(convId, { text, attachments = [] }) { return this._withLock(convId, () => this._sendLocked(convId, { sub: "msg", payload: { v: 1, t: "msg", id: clientMsgId(), text: String(text ?? ""), attachments } })); }
  async editMessage(convId, serverId, text) { return this._withLock(convId, () => this._sendLocked(convId, { sub: "edit", target: serverId, payload: { v: 1, t: "edit", target: serverId, text: String(text ?? "") } })); }
  async deleteMessage(convId, serverId) { return this._withLock(convId, () => this._sendLocked(convId, { sub: "delete", target: serverId, payload: { v: 1, t: "del", target: serverId } })); }
  async rename(convId, title) { const meta = await this._meta(convId); meta.title = String(title).slice(0, 120); await this._saveMeta(convId, meta); return this._withLock(convId, () => this._sendLocked(convId, { sub: "rename", payload: { v: 1, t: "rename", title: meta.title } })); }

  async _sendLocked(convId, { sub, payload, target = null }) {
    const id = payload.id || clientMsgId();
    for (let attempt = 0; attempt < 4; attempt++) {
      let state = await this._state(convId); if (!state) throw new Error("This conversation is not available on this device.");
      const enc = await M.encryptApplication({ state, bytes: te.encode(JSON.stringify(payload)) });
      const entry = { id, sub, target, wire: M.toB64(enc.wire), epoch: Number(state.groupContext.epoch), payload };
      try {
        const r = await this.api.sendMessage({ deviceId: this.device.deviceId, conversationId: convId, clientMsgId: id, sub, ciphertext: entry.wire, targetMessageId: target });
        await this._saveState(convId, enc.newState);
        this.metrics.sent++;
        if (sub === "msg") {
          const msgs = await this._msgs(convId);
          msgs.push({ seq: r.seq, serverId: r.id, at: new Date(this.now()).toISOString(), from: this.email, text: payload.text, attachments: payload.attachments || [], clientMsgId: id, status: "sent" });
          await this._saveMsgs(convId, msgs);
        } else if (sub === "edit" || sub === "delete") {
          const msgs = await this._msgs(convId); const t = msgs.find((m) => m.serverId === target);
          if (t) { if (sub === "edit") { t.text = payload.text; t.editedAt = new Date(this.now()).toISOString(); } else { t.text = ""; t.attachments = []; t.deleted = true; } await this._saveMsgs(convId, msgs); }
        }
        const cur = await this._cursor(convId); if (r.seq === cur + 1) await this._setCursor(convId, r.seq);
        return { serverId: r.id, seq: r.seq, duplicate: !!r.duplicate };
      } catch (err) {
        if (err.code === "STALE_EPOCH" || err.code === "RECONCILE_REQUIRED") {
          // Our encryption consumed a key at an epoch that is now stale: drop it, catch up, apply any removal, and encrypt again.
          await this._pullLocked(convId);
          await this._reconcileLocked(convId);
          continue;
        }
        if (!err.status || err.status >= 500) { await this._queueOutbox(convId, entry, enc.newState); throw Object.assign(err, { queued: true }); }
        throw err;
      }
    }
    throw new Error("Could not send: the conversation kept changing. Try again.");
  }

  async _queueOutbox(convId, entry, newState) {
    await this._saveState(convId, newState); // the key is consumed either way
    const box = (await this.store.get(`outbox:${convId}`)) || []; box.push(entry); await this.store.set(`outbox:${convId}`, box);
  }
  async _flushOutbox() {
    for (const k of await this.store.keys("outbox:")) {
      const convId = k.slice(7); const box = (await this.store.get(k)) || []; const keep = [];
      for (const e of box) {
        try { await this.api.sendMessage({ deviceId: this.device.deviceId, conversationId: convId, clientMsgId: e.id, sub: e.sub, ciphertext: e.wire, targetMessageId: e.target }); }
        catch (err) { if (err.code === "STALE_EPOCH") { /* the queued ciphertext is for an old epoch: re-encrypt */ await this._withLock(convId, () => this._sendLocked(convId, { sub: e.sub, payload: e.payload, target: e.target })).catch(() => keep.push(e)); } else keep.push(e); }
      }
      if (keep.length) await this.store.set(k, keep); else await this.store.delete(k);
    }
  }

  // ------------------------------------------------------------------------------------------- attachments

  /** Encrypt a file on this device, upload only ciphertext, and return the descriptor to put in a message. */
  async attachFile(convId, { bytes, name, type }) { return uploadEncrypted({ api: this.api, conversationId: convId, bytes, name, type }); }
  attachInayaDocument({ documentId, name, size }) { return inayaDocRef({ documentId, name, size }); }
  async downloadAttachment(convId, descriptor) {
    if (descriptor.kind !== "blob") throw new Error("Open Inaya documents from the Files view; chat holds only a reference to them.");
    return downloadDecrypted({ api: this.api, conversationId: convId, descriptor });
  }

  // ------------------------------------------------------------------------------------------- read side

  async messages(convId) { return (await this._msgs(convId)).filter((m) => !m.deleted || true).sort((a, b) => a.seq - b.seq); }
  async title(convId) { return (await this._meta(convId)).title; }

  /** Local search over decrypted messages and titles. The server never sees the query. */
  async search(query, { limit = 50 } = {}) {
    const q = String(query || "").trim().toLowerCase(); if (!q) return [];
    const out = [];
    for (const k of await this.store.keys("msgs:")) {
      const convId = k.slice(5);
      for (const m of (await this.store.get(k)) || []) if (!m.deleted && m.text.toLowerCase().includes(q)) out.push({ conversationId: convId, serverId: m.serverId, seq: m.seq, from: m.from, text: m.text, at: m.at });
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  /** Safety number for a participant: stable digest of that person's device fingerprints. Compare out of band. */
  safetyNumber(roster, email) {
    const p = roster.find((r) => r.email === email); if (!p) return null;
    return p.fingerprints.map((f) => f.fingerprint).filter(Boolean).sort().join("|").slice(0, 120);
  }

  /** Erases the readable history on this device (decrypted messages and unsent drafts) but keeps the device identity and group state, so it stays a working member.
   *  Erased history cannot be fetched again: old messages cannot be decrypted a second time. */
  async clearCache() { let n = 0; for (const p of ["msgs:", "outbox:"]) for (const k of await this.store.keys(p)) { await this.store.delete(k); n++; } return { erased: n }; }

  /** Sign-out / revoked device: delete every secret and cache from this device. */
  async wipeLocal() { await this.store.clear(); this.device = null; this.kps = {}; this.pins = {}; this.rosters = {}; }
}
