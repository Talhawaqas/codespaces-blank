// src/lib/chat/client/httpApi.js
//
// The ChatClient server adapter for apps: the same methods as directApi.js, over the /api/orgs/chat routes. The session cookie
// authenticates the person; the x-inaya-device header names the device. Errors carry { status, code } like the server's.

export class HttpChatApi {
  constructor({ orgId, baseUrl = "", fetchImpl, headers = {}, deviceId = null }) {
    this.orgId = String(orgId); this.base = baseUrl.replace(/\/$/, "") + "/api/orgs/chat"; this.f = fetchImpl || ((...a) => fetch(...a)); this.headers = headers; this.deviceId = deviceId;
  }
  setDevice(id) { this.deviceId = id; }
  async _(method, path, { query = {}, body } = {}) {
    const q = new URLSearchParams({ orgId: this.orgId, ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)) });
    const res = await this.f(`${this.base}${path}?${q}`, {
      method, credentials: "include",
      headers: { "Content-Type": "application/json", ...(this.deviceId ? { "x-inaya-device": this.deviceId } : {}), ...this.headers },
      body: body === undefined ? undefined : JSON.stringify({ orgId: this.orgId, ...body }),
    });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, code: data?.code || null });
    return data;
  }
  enrollDevice(p) { return this._("POST", "/devices", { body: p }); }
  keyPackageStatus({ deviceId }) { return this._("GET", `/devices/${deviceId}/keypackages`); }
  uploadKeyPackages({ deviceId, packages, lastResort }) { return this._("POST", `/devices/${deviceId}/keypackages`, { body: { packages, lastResort: !!lastResort } }); }
  claimKeyPackages({ conversationId, deviceIds }) { return this._("POST", `/conversations/${conversationId}/claim`, { body: { deviceIds } }); }
  createConversation(p) { return this._("POST", "/conversations", { body: p }); }
  conversationDetail({ conversationId }) { return this._("GET", `/conversations/${conversationId}`); }
  submitCommit({ conversationId, baseEpoch, commit, welcome, clientCommitId }) { return this._("POST", `/conversations/${conversationId}/commits`, { body: { baseEpoch, commit, welcome, clientCommitId } }); }
  sendMessage({ conversationId, clientMsgId, sub, ciphertext, targetMessageId }) { return this._("POST", `/conversations/${conversationId}/messages`, { body: { clientMsgId, sub, ciphertext, targetMessageId } }); }
  listMessages({ conversationId, afterSeq, limit }) { return this._("GET", `/conversations/${conversationId}/messages`, { query: { afterSeq, limit } }); }
  sync({ cursors, since, wait }) { return this._("GET", "/sync", { query: { cursors: JSON.stringify(cursors || {}), since, wait } }); }
  ackWelcome({ conversationId, epoch }) { return this._("POST", "/welcomes", { body: { conversationId, epoch } }); }
  addParticipants({ conversationId, emails, external }) { return this._("POST", `/conversations/${conversationId}/participants`, { body: { emails, external } }); }
  removeParticipant({ conversationId, targetEmail }) { return this._("DELETE", `/conversations/${conversationId}/participants/${encodeURIComponent(targetEmail)}`); }
  leaveConversation({ conversationId }) { return this._("POST", `/conversations/${conversationId}/leave`, { body: {} }); }
  markRead({ conversationId, seq }) { return this._("POST", `/conversations/${conversationId}/read`, { body: { seq } }); }
  beginAttachment({ conversationId, size, partCount }) { return this._("POST", "/attachments", { body: { action: "begin", conversationId, size, partCount } }); }
  uploadPart({ conversationId, blobId, index, data }) { return this._("POST", "/attachments", { body: { action: "part", conversationId, blobId, index, data } }); }
  completeAttachment({ conversationId, blobId }) { return this._("POST", "/attachments", { body: { action: "complete", conversationId, blobId } }); }
  readPart({ conversationId, blobId, index }) { return this._("GET", "/attachments", { query: { conversationId, blobId, index } }); }
  getTyping({ conversationId }) { return this._("GET", `/conversations/${conversationId}/typing`); }
  receipts({ conversationId }) { return this._("GET", `/conversations/${conversationId}/read`); }
  contactList() { return this._("GET", "/contacts"); }
  cancelRequest(id) { return this._("DELETE", `/contacts/requests/${id}`); }
  removeContact(id) { return this._("DELETE", `/contacts/${id}`); }
  block(email) { return this._("POST", "/contacts/block", { body: { email } }); }
  unblock(email) { return this._("DELETE", "/contacts/block", { query: { email } }); }
  prefs() { return this._("GET", "/preferences"); }
  setPrefs(patch) { return this._("PATCH", "/preferences", { body: patch }); }
  chatSettings() { return this._("GET", "/settings"); }
  setChatSettings(patch) { return this._("PATCH", "/settings", { body: patch }); }
  patchConversation(conversationId, patch) { return this._("PATCH", `/conversations/${conversationId}`, { body: patch }); }
  deleteConversation(conversationId) { return this._("DELETE", `/conversations/${conversationId}`); }
  setTyping({ conversationId, typing }) { return this._("POST", `/conversations/${conversationId}/typing`, { body: { typing } }); }
  heartbeat() { return this._("PUT", "/presence", { body: {} }); }
  presence(emails) { return this._("GET", "/presence", { query: { emails: emails.join(",") } }); }
  mute(conversationId, muted) { return this._("POST", `/conversations/${conversationId}/mute`, { body: { muted } }); }
  contacts(q) { return this._("GET", "/contacts", { query: { q } }); }
  requestContact({ to, purpose }) { return this._("POST", "/contacts/requests", { body: { to, purpose } }); }
  acceptRequest(id) { return this._("POST", `/contacts/requests/${id}/accept`, { body: {} }); }
  denyRequest(id) { return this._("POST", `/contacts/requests/${id}/deny`, { body: {} }); }
  listDevices() { return this._("GET", "/devices"); }
  revokeDevice(deviceId) { return this._("POST", `/devices/${deviceId}/revoke`, { body: {} }); }
}
