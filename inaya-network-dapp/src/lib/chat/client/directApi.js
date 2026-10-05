// src/lib/chat/client/directApi.js
//
// A ChatClient "server adapter" that calls the server modules in-process (no HTTP). Used by the tests so the full protocol --
// real MLS on the client side, real validation and real MongoDB on the server side -- runs without a web server. The HTTP
// adapter (httpApi.js) exposes exactly the same methods over the routes.

import * as dev from "../devices.js";
import * as conv from "../conversations.js";
import * as att from "../attachments.js";

export class DirectApi {
  constructor({ orgId, membership, email }) { this.orgId = String(orgId); this.membership = membership; this.email = email; }
  _ = () => ({ orgId: this.orgId, membership: this.membership, email: this.email });
  enrollDevice(p) { return dev.enrollDevice({ ...this._(), ...p }); }
  keyPackageStatus(p) { return dev.keyPackageStatus({ ...this._(), ...p }); }
  uploadKeyPackages(p) { return dev.uploadKeyPackages({ ...this._(), ...p }); }
  claimKeyPackages(p) { return conv.claimForCommit({ ...this._(), ...p }); }
  createConversation(p) { return conv.createConversation({ ...this._(), ...p }); }
  conversationDetail(p) { return conv.conversationDetail({ ...this._(), ...p }); }
  submitCommit(p) { return conv.submitCommit({ ...this._(), ...p }); }
  sendMessage(p) { return conv.submitMessage({ ...this._(), ...p }); }
  listMessages(p) { return conv.listMessages({ ...this._(), ...p }); }
  sync(p) { return conv.syncState({ ...this._(), ...p }); }
  ackWelcome(p) { return conv.ackWelcome({ ...this._(), ...p }); }
  addParticipants(p) { return conv.addParticipants({ ...this._(), ...p }); }
  removeParticipant(p) { return conv.removeParticipant({ ...this._(), email: this.email, targetEmail: p.targetEmail, conversationId: p.conversationId }); }
  leaveConversation(p) { return conv.leaveConversation({ ...this._(), ...p }); }
  beginAttachment(p) { return att.beginAttachment({ ...this._(), ...p }); }
  uploadPart(p) { return att.uploadPart({ ...this._(), ...p }); }
  completeAttachment(p) { return att.completeAttachment({ ...this._(), ...p }); }
  readPart(p) { return att.readPart({ ...this._(), ...p }); }
  markRead(p) { return conv.markRead({ ...this._(), ...p }); }
}
