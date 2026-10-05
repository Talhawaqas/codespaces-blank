// src/lib/chat/mlsServer.js
//
// What the server is allowed to understand about MLS traffic. It parses only the PUBLIC parts of the wire format:
//   - KeyPackages (credential identity, signature key, signature, lifetime) -- to bind a device to an authenticated user;
//   - public-message commits (group id, epoch, sender leaf, Add/Remove proposals) -- to authorize membership changes;
//   - Welcome (which KeyPackage references it is addressed to);
//   - private-message headers (group id, epoch, content type) -- to stop substitution across conversations and epochs.
// It cannot read an application message and holds no group secret. See docs/architecture/e2ee-chat-key-management.md.

import { createHash } from "node:crypto";
import { getCiphersuiteImpl, getCiphersuiteFromName, decodeMlsMessage } from "ts-mls";
import { verifyKeyPackage, makeKeyPackageRef } from "ts-mls/keyPackage.js";
import { CHAT_SUITE, ChatError, parseIdentity } from "./common.js";

let implPromise;
export const getImpl = () => (implPromise ||= getCiphersuiteImpl(getCiphersuiteFromName(CHAT_SUITE)));

const hex = (u8) => Buffer.from(u8).toString("hex");
const utf8 = (u8) => Buffer.from(u8).toString("utf8");
const bad = (msg, code = "BAD_MLS") => new ChatError(400, msg, code);

export function decodeWire(bytes) {
  let decoded;
  try { decoded = decodeMlsMessage(bytes, 0); } catch { throw bad("The encrypted payload could not be decoded."); }
  if (!decoded || !decoded[0]) throw bad("The encrypted payload could not be decoded.");
  // Reject trailing garbage: the whole buffer must be exactly one message.
  if (decoded[1] !== bytes.length) throw bad("The encrypted payload has trailing data.");
  return decoded[0];
}

export async function inspectKeyPackage(bytes) {
  const m = decodeWire(bytes);
  if (m.wireformat !== "mls_key_package") throw bad("Expected a KeyPackage.");
  const kp = m.keyPackage;
  if (kp.cipherSuite !== CHAT_SUITE) throw bad("Unsupported cipher suite.", "BAD_SUITE");
  const cred = kp.leafNode.credential;
  if (cred.credentialType !== "basic") throw bad("Only basic credentials are accepted.", "BAD_CREDENTIAL");
  const identity = parseIdentity(utf8(cred.identity));
  if (!identity) throw bad("The credential identity is malformed.", "BAD_CREDENTIAL");
  const impl = await getImpl();
  let ok = false;
  try { ok = await verifyKeyPackage(kp, impl.signature); } catch { ok = false; }
  if (!ok) throw bad("The KeyPackage signature is invalid.", "BAD_SIGNATURE");
  const lt = kp.leafNode.lifetime;
  const notAfterMs = Number(lt?.notAfter ?? 0n) * 1000;
  const notBeforeMs = Number(lt?.notBefore ?? 0n) * 1000;
  const refHex = hex(await makeKeyPackageRef(kp, impl.hash));
  return { keyPackage: kp, identity, signaturePublicKeyHex: hex(kp.leafNode.signaturePublicKey), refHex, notAfterMs, notBeforeMs };
}

/** Public-message commit: what the server needs for authorization. */
export function inspectCommit(bytes) {
  const m = decodeWire(bytes);
  if (m.wireformat !== "mls_public_message") throw bad("Commits must be sent as public messages.", "COMMIT_NOT_PUBLIC");
  const c = m.publicMessage.content;
  if (c.contentType !== "commit") throw bad("Expected a commit.");
  if (c.sender.senderType !== "member") throw bad("Commits must come from a member.");
  const adds = []; const removes = []; let other = 0;
  for (const p of c.commit.proposals) {
    if (p.proposalOrRefType !== "proposal") { other++; continue; } // by-reference proposals are not used by Inaya clients
    const pr = p.proposal;
    if (pr.proposalType === "add") adds.push(pr.add.keyPackage);
    else if (pr.proposalType === "remove") removes.push(Number(pr.remove.removed));
    else other++;
  }
  const path = c.commit.path;
  return {
    groupIdHex: hex(c.groupId),
    epoch: Number(c.epoch),
    senderLeaf: Number(c.sender.leafIndex),
    adds, removes, other,
    hasPath: !!path,
    pathIdentity: path ? parseIdentity(utf8(path.leafNode.credential.identity || new Uint8Array())) : null,
  };
}

export async function keyPackageRefHex(keyPackage) {
  const impl = await getImpl();
  return hex(await makeKeyPackageRef(keyPackage, impl.hash));
}

export function inspectWelcome(bytes) {
  const m = decodeWire(bytes);
  if (m.wireformat !== "mls_welcome") throw bad("Expected a Welcome.");
  return { recipientRefHexes: m.welcome.secrets.map((s) => hex(s.newMember)) };
}

export function inspectPrivateMessage(bytes) {
  const m = decodeWire(bytes);
  if (m.wireformat !== "mls_private_message") throw bad("Application messages must be private messages.", "NOT_PRIVATE");
  const p = m.privateMessage;
  return { groupIdHex: hex(p.groupId), epoch: Number(p.epoch), contentType: p.contentType };
}

export const sha256Hex = (u8) => createHash("sha256").update(u8).digest("hex");

/** Mirrors RFC 9420 leaf allocation (section 12.4.2): removals blank leaves, the tree shrinks while its right half is blank,
 *  each Add takes the leftmost blank leaf or extends the tree. The server uses this ONLY to map leaf indices to devices for
 *  authorizing Remove proposals; clients independently verify the real tree, and a test compares the two. */
export function applyLeafChanges(leaves, { removes, addDeviceIds }) {
  const out = leaves.slice();
  for (const r of removes) { if (r < 0 || r >= out.length || out[r] === null) throw bad("Remove refers to an empty leaf.", "BAD_REMOVE"); out[r] = null; }
  const size = (n) => { let s = 1; while (s < n) s *= 2; return s; };
  let last = out.length - 1; while (last >= 0 && out[last] === null) last--;
  out.length = last + 1;
  let treeSize = size(Math.max(out.length, 1));
  for (const d of addDeviceIds) {
    let slot = -1;
    for (let i = 0; i < Math.min(out.length, treeSize); i++) if (out[i] === null) { slot = i; break; }
    if (slot === -1) { slot = out.length; if (slot >= treeSize) treeSize = size(slot + 1); }
    out[slot] = d;
  }
  return out;
}
