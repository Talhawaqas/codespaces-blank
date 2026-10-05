// src/sign.js -- request signing. The server (src/lib/gateway/gateway.js in the Inaya app) builds the same strings; a test in the app pins the two together.
import { createHash, sign as edSign, generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

export const sha256Hex = (v) => createHash("sha256").update(v).digest("hex");
export const signingString = ({ method, path, ts, nonce, body }) => `${String(method).toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha256Hex(body || "")}`;
export const enrollProofString = ({ tokenHash, ts }) => `enroll\n${tokenHash}\n${ts}`;

/** A new Ed25519 identity. The private key stays on this machine (in the encrypted config); only the public key is ever sent. */
export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
export const publicKeyOf = (privateKeyPem) => createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" }).toString("base64");
export const signB64 = (privateKeyPem, data) => edSign(null, Buffer.from(data), createPrivateKey(privateKeyPem)).toString("base64");

export function signedHeaders({ gatewayId, privateKeyPem, method, path, body, now = Date.now(), nonce = randomBytes(16).toString("hex") }) {
  const ts = String(now);
  return { "x-inaya-gateway": gatewayId, "x-inaya-timestamp": ts, "x-inaya-nonce": nonce, "x-inaya-signature": signB64(privateKeyPem, signingString({ method, path, ts, nonce, body })) };
}
