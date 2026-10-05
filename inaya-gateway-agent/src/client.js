// src/client.js -- the agent's only network path: OUTBOUND HTTPS to Inaya. No listener is ever opened. Every call after enrollment is signed with the
// gateway's private key; a revoked gateway gets 401 and stops.
import { signedHeaders, generateIdentity, signB64, enrollProofString, sha256Hex } from "./sign.js";

export class RevokedError extends Error { constructor() { super("This gateway was revoked by the organization."); this.revoked = true; } }
export class ApiError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }

export function makeClient({ baseUrl, gatewayId, privateKeyPem, fetchImpl = globalThis.fetch, retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const root = String(baseUrl).replace(/\/$/, "");
  async function call(method, path, body) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let res;
      try { res = await fetchImpl(root + path, { method, headers: { ...(raw ? { "content-type": "application/json" } : {}), ...signedHeaders({ gatewayId, privateKeyPem, method, path, body: raw }) }, ...(raw ? { body: raw } : {}) }); }
      catch (e) { if (attempt >= retries) throw Object.assign(new Error(`Could not reach Inaya: ${e.message}`), { network: true }); await sleep(Math.min(30_000, 500 * 2 ** attempt)); continue; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.code === "REVOKED") throw new RevokedError();
      if (res.status >= 500 || res.status === 429) { if (attempt >= retries) throw new ApiError(res.status, data.error || "Server error.", data); await sleep(Math.min(30_000, 500 * 2 ** attempt)); continue; }
      if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`, data);
      return data;
    }
  }
  return { call, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b ?? {}) };
}

/** Exchanges a one-time enrollment token for a registration. Only the public key leaves this machine. */
export async function enrollGateway({ baseUrl, token, label, version, platform, capabilities, fetchImpl = globalThis.fetch }) {
  const id = generateIdentity(); const ts = String(Date.now());
  const res = await fetchImpl(String(baseUrl).replace(/\/$/, "") + "/api/gateway/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, publicKey: id.publicKey, proof: signB64(id.privateKeyPem, enrollProofString({ tokenHash: sha256Hex(token), ts })), ts, label, version, platform, capabilities }) });
  const data = await res.json().catch(() => ({})); if (!res.ok) throw new ApiError(res.status, data.error || "Enrollment failed.", data);
  return { gatewayId: data.gatewayId, privateKeyPem: id.privateKeyPem, publicKey: id.publicKey, fingerprint: data.fingerprint };
}
