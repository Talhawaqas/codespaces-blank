// src/lib/chat/client/mls.js
//
// The device-side MLS layer (browser, Node, desktop webview, and -- with nobleCryptoProvider -- React Native).
// Pure functions over ts-mls: no network, no storage. Private keys and group state exist only in the objects these functions
// return; the caller (ChatClient) persists them sealed. Nothing here is ever sent to the server except the public wire
// messages (KeyPackages, commits, Welcomes, private messages) that MLS itself produces.

import {
  createApplicationMessage, createCommit, createGroup, joinGroup, processMessage, getCiphersuiteImpl, getCiphersuiteFromName,
  defaultCapabilities, emptyPskIndex, generateKeyPackageWithKey, encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState,
  nobleCryptoProvider,
} from "ts-mls";
import { decryptSenderData } from "ts-mls/privateMessage.js";
import { defaultClientConfig } from "ts-mls/clientConfig.js";

export const CHAT_SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const enc = new TextEncoder(); const dec = new TextDecoder();
const toB64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
const fromB64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const bytesToHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export { toB64, fromB64, hexToBytes, bytesToHex };

export const deviceIdentity = (orgId, email, deviceId) => `inaya:v1:${orgId}:${String(email).trim().toLowerCase()}:${deviceId}`;
export function parseIdentity(str) {
  const m = /^inaya:v1:([0-9a-f]{24}):([^:\s]+@[^:\s]+):([0-9a-f]{24})$/.exec(String(str || ""));
  return m ? { orgId: m[1], email: m[2], deviceId: m[3] } : null;
}

let implPromise;
/** `provider: "noble"` selects the pure-JS crypto provider for runtimes without crypto.subtle (React Native). */
export function getImpl({ provider } = {}) {
  if (!implPromise) implPromise = getCiphersuiteImpl(getCiphersuiteFromName(CHAT_SUITE), provider === "noble" ? nobleCryptoProvider : undefined);
  return implPromise;
}

/** Credential validation for every credential a client meets: a well-formed Inaya identity and, through `pin(identity, keyHex)`,
 *  trust-on-first-use pinning of each device's signature key (a later, different key for the same device is refused, so a
 *  server cannot swap a known device's key). */
export function makeAuthService({ pin } = {}) {
  return {
    async validateCredential(credential, signaturePublicKey) {
      if (credential.credentialType !== "basic") return false;
      const id = parseIdentity(dec.decode(credential.identity));
      if (!id) return false;
      return pin ? !!(await pin(id, bytesToHex(signaturePublicKey))) : true;
    },
  };
}

export function clientConfigFor(authService) { return { ...defaultClientConfig, authService }; }

// ------------------------------------------------------------------------------------------------ device keys

export async function newSignatureKeys() { const impl = await getImpl(); const k = await impl.signature.keygen(); return { signKey: k.signKey, publicKey: k.publicKey }; }

/** Fresh KeyPackage (new init + HPKE keys, same long-lived signature key). */
export async function makeKeyPackage({ identity, sigKeys, lifetimeDays = 90 }) {
  const impl = await getImpl();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const lifetime = { notBefore: nowSec - 60n, notAfter: nowSec + BigInt(lifetimeDays * 86400) };
  const kp = await generateKeyPackageWithKey({ credentialType: "basic", identity: enc.encode(identity) }, defaultCapabilities(), lifetime, [], sigKeys, impl);
  const wire = encodeMlsMessage({ keyPackage: kp.publicPackage, wireformat: "mls_key_package", version: "mls10" });
  return { wire, publicPackage: kp.publicPackage, privatePackage: kp.privatePackage };
}

export const packPrivate = (p) => ({ i: toB64(p.initPrivateKey), h: toB64(p.hpkePrivateKey), s: toB64(p.signaturePrivateKey) });
export const unpackPrivate = (p) => ({ initPrivateKey: fromB64(p.i), hpkePrivateKey: fromB64(p.h), signaturePrivateKey: fromB64(p.s) });

// ------------------------------------------------------------------------------------------------ group state

export function serializeState(state) { return toB64(encodeGroupState(state)); }
export function deserializeState(b64, clientConfig) { const [gs] = decodeGroupState(fromB64(b64), 0); return { ...gs, clientConfig }; }

export async function createGroupState({ groupIdHex, kp, clientConfig }) {
  const impl = await getImpl();
  return createGroup(hexToBytes(groupIdHex), kp.publicPackage, kp.privatePackage, [], impl, clientConfig);
}

/** Leaf index of every non-blank leaf -> credential identity string. */
export function leafIdentities(state) {
  const out = new Map();
  const tree = state.ratchetTree;
  for (let i = 0; i < tree.length; i += 2) {
    const n = tree[i];
    if (n && n.nodeType === "leaf" && n.leaf) out.set(i / 2, dec.decode(n.leaf.credential.identity));
  }
  return out;
}

const encodePublic = (m) => encodeMlsMessage(m);

/** Build a commit (public message) that adds KeyPackages and/or removes leaves. Returns the wire bytes to send, the Welcome
 *  (if any) and the state to adopt ONLY after the server accepts the commit. */
export async function buildCommit({ state, adds = [], removeLeaves = [] }) {
  const impl = await getImpl();
  const proposals = [
    ...removeLeaves.map((removed) => ({ proposalType: "remove", remove: { removed } })),
    ...adds.map((kpWire) => {
      const m = decodeMlsMessage(kpWire, 0)[0];
      return { proposalType: "add", add: { keyPackage: m.keyPackage } };
    }),
  ];
  const r = await createCommit({ state, cipherSuite: impl }, { wireAsPublicMessage: true, ratchetTreeExtension: true, extraProposals: proposals });
  r.consumed?.forEach((u) => u.fill(0));
  return {
    commitWire: encodeMlsMessage(r.commit),
    welcomeWire: r.welcome ? encodeMlsMessage({ welcome: r.welcome, wireformat: "mls_welcome", version: "mls10" }) : null,
    newState: r.newState,
  };
}

export async function joinFromWelcome({ welcomeWire, kp, ratchetTreeFrom, clientConfig }) {
  const impl = await getImpl();
  const m = decodeMlsMessage(welcomeWire, 0)[0];
  if (m.wireformat !== "mls_welcome") throw new Error("Not a Welcome.");
  // The ratchet tree travels inside the Welcome's GroupInfo extension when the committer attached it; otherwise the caller
  // provides it. Inaya commits attach it (see buildCommit options in ChatClient) so no out-of-band tree is needed.
  return joinGroup(m.welcome, kp.publicPackage, kp.privatePackage, emptyPskIndex, impl, ratchetTreeFrom, undefined, clientConfig);
}

/** Process a commit that someone else made. `policy(commitInfo)` returns true to accept (client-side authorization). */
export async function processCommit({ state, commitWire, policy }) {
  const impl = await getImpl();
  const m = decodeMlsMessage(commitWire, 0)[0];
  const callback = (incoming) => {
    if (incoming.kind !== "commit") return "reject"; // standalone proposals are never used by Inaya clients
    return policy(incoming) ? "accept" : "reject";
  };
  const r = await processMessage(m, state, emptyPskIndex, callback, impl);
  r.consumed?.forEach((u) => u.fill(0));
  if (r.kind !== "newState") throw new Error("Expected a commit.");
  return { newState: r.newState, accepted: r.actionTaken === "accept" };
}

export async function encryptApplication({ state, bytes }) {
  const impl = await getImpl();
  const r = await createApplicationMessage(state, bytes, impl);
  r.consumed?.forEach((u) => u.fill(0));
  return { wire: encodeMlsMessage({ privateMessage: r.privateMessage, wireformat: "mls_private_message", version: "mls10" }), newState: r.newState };
}

/** Decrypts one application message and reports WHO sent it, taken from the MLS-authenticated sender leaf (never from the
 *  payload, which any member could forge). */
export async function decryptApplication({ state, wire }) {
  const impl = await getImpl();
  const m = decodeMlsMessage(wire, 0)[0];
  if (m.wireformat !== "mls_private_message") throw new Error("Not an application message.");
  const sd = await decryptSenderData(m.privateMessage, state.keySchedule.senderDataSecret, impl);
  const r = await processMessage(m, state, emptyPskIndex, () => "reject", impl);
  r.consumed?.forEach((u) => u.fill(0));
  if (r.kind !== "applicationMessage") throw new Error("Expected an application message.");
  const sender = sd ? leafIdentities(state).get(Number(sd.leafIndex)) : null;
  return { plaintext: r.message, newState: r.newState, senderIdentity: sender ? parseIdentity(sender) : null };
}
