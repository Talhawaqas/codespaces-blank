// src/lib/keys/providers.js
//
// Customer-managed key providers (Competitive Expansion SOW Q, KEY-001). Envelope encryption: the key provider only ever wraps and unwraps a small DATA KEY (here, the per-organization
// passphrase of the server-managed S3/Azure layer). It NEVER receives file plaintext, and it never needs to: files are encrypted with that data key, not by the provider.
//
//   platform   the existing behaviour: AES-256-GCM under a platform master key held in the deployment's environment (S3_COMPAT_ENCRYPTION_KEY).
//   local      key material the customer's own deployment supplies (CMK_LOCAL_KEYS: JSON { "<keyId>": "<base64 32-byte key>" }), for controlled deployments. AES-256-GCM.
//   kms        a customer-owned AWS KMS key (Encrypt/Decrypt with an EncryptionContext). Region and an optional endpoint come from the organization's configuration; credentials come from the
//              deployment's standard AWS credential chain, so the customer grants the deployment access to THEIR key and can revoke it at any time.
//
// Every wrap and unwrap is bound to the TENANT (organization id), the PURPOSE and the ENVIRONMENT through authenticated context: a blob wrapped for one organization or environment
// cannot be unwrapped for another, even with the right key. The KMS provider passes the same values as the KMS EncryptionContext.

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export class KeyError extends Error { constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; } }
export const PROVIDER_IDS = ["platform", "local", "kms"];
export const environmentName = (env = process.env) => String(env.INAYA_ENV || env.VERCEL_ENV || env.NODE_ENV || "development");
export const contextFor = ({ orgId, purpose, env }) => ({ orgId: String(orgId), purpose: String(purpose), environment: String(env || environmentName()) });
const aad = (ctx) => Buffer.from(JSON.stringify([ctx.orgId, ctx.purpose, ctx.environment]));

function aesWrap(key, plaintext, ctx) { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); c.setAAD(aad(ctx)); const ct = Buffer.concat([c.update(plaintext), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"); }
function aesUnwrap(key, b64, ctx) { const raw = Buffer.from(String(b64), "base64"); if (raw.length < 29) throw new KeyError("BAD_ENVELOPE", "The wrapped key is malformed."); const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAAD(aad(ctx)); d.setAuthTag(raw.subarray(12, 28)); try { return Buffer.concat([d.update(raw.subarray(28)), d.final()]); } catch { throw new KeyError("UNWRAP_FAILED", "The key could not unwrap this data: wrong key, wrong organization or environment, or the data was altered."); } }

// ---- platform
export const platform = {
  id: "platform", label: "Platform-managed key",
  async wrap({ plaintext, context }) { const k = Buffer.from(process.env.S3_COMPAT_ENCRYPTION_KEY || "", "base64"); if (k.length !== 32) throw new KeyError("NOT_CONFIGURED", "The platform key is not configured."); return { ciphertext: aesWrap(k, plaintext, context), keyRef: "platform", keyVersion: "1" }; },
  async unwrap({ envelope, context }) { const k = Buffer.from(process.env.S3_COMPAT_ENCRYPTION_KEY || "", "base64"); if (k.length !== 32) throw new KeyError("NOT_CONFIGURED", "The platform key is not configured."); return aesUnwrap(k, envelope.ciphertext, context); },
  async check() { return { ok: !!process.env.S3_COMPAT_ENCRYPTION_KEY }; },
};

// ---- local
export function localKeys(env = process.env) { try { const j = JSON.parse(env.CMK_LOCAL_KEYS || "{}"); const out = {}; for (const [id, v] of Object.entries(j)) { const b = Buffer.from(String(v), "base64"); if (b.length === 32 && /^[A-Za-z0-9._-]{1,64}$/.test(id)) out[id] = b; } return out; } catch { return {}; } }
export const local = {
  id: "local", label: "Local key material (customer deployment)",
  async wrap({ plaintext, context, keyRef }) { const k = localKeys()[keyRef]; if (!k) throw new KeyError("KEY_UNAVAILABLE", `Local key "${keyRef}" is not present in this deployment.`); return { ciphertext: aesWrap(k, plaintext, context), keyRef, keyVersion: keyRef }; },
  async unwrap({ envelope, context }) { const k = localKeys()[envelope.keyRef]; if (!k) throw new KeyError("KEY_UNAVAILABLE", `Local key "${envelope.keyRef}" is not present in this deployment.`); return aesUnwrap(k, envelope.ciphertext, context); },
  async check({ keyRef }) { return { ok: !!localKeys()[keyRef], detail: localKeys()[keyRef] ? "present" : "not present in this deployment" }; },
};

// ---- kms
async function kmsClient({ region, endpoint }) {
  const { KMSClient } = await import("@aws-sdk/client-kms");
  return new KMSClient({ region: region || process.env.AWS_REGION || "us-east-1", ...(endpoint ? { endpoint, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || "stub", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "stub" } } : {}) });
}
const ec = (ctx) => ({ orgId: ctx.orgId, purpose: ctx.purpose, environment: ctx.environment });
export const kms = {
  id: "kms", label: "AWS KMS (customer-owned key)",
  async wrap({ plaintext, context, keyRef, options = {} }) {
    const { EncryptCommand } = await import("@aws-sdk/client-kms"); const c = await kmsClient(options);
    try { const r = await c.send(new EncryptCommand({ KeyId: keyRef, Plaintext: plaintext, EncryptionContext: ec(context) })); return { ciphertext: Buffer.from(r.CiphertextBlob).toString("base64"), keyRef: r.KeyId || keyRef, keyVersion: "kms" }; }
    catch (e) { throw new KeyError(mapKmsError(e), `The key service refused the request (${String(e.name || e.code || e.message).slice(0, 60)}).`, 502); }
  },
  async unwrap({ envelope, context, options = {} }) {
    const { DecryptCommand } = await import("@aws-sdk/client-kms"); const c = await kmsClient(options);
    try { const r = await c.send(new DecryptCommand({ CiphertextBlob: Buffer.from(envelope.ciphertext, "base64"), EncryptionContext: ec(context), KeyId: envelope.keyRef })); return Buffer.from(r.Plaintext); }
    catch (e) { throw new KeyError(mapKmsError(e), `The key service refused the request (${String(e.name || e.code || e.message).slice(0, 60)}).`, 502); }
  },
  async check({ keyRef, options = {} }) { try { const probe = randomBytes(32); const ctx = contextFor({ orgId: "probe", purpose: "key-check" }); const w = await kms.wrap({ plaintext: probe, context: ctx, keyRef, options }); const u = await kms.unwrap({ envelope: w, context: ctx, options }); return { ok: Buffer.compare(probe, u) === 0 }; } catch (e) { return { ok: false, detail: e.code || e.message }; } },
};
const mapKmsError = (e) => (/AccessDenied|NotAuthorized/i.test(e?.name) ? "ACCESS_DENIED" : /Disabled|PendingDeletion|InvalidState/i.test(e?.name) ? "KEY_DISABLED" : /NotFound/i.test(e?.name) ? "KEY_NOT_FOUND" : /InvalidCiphertext|IncorrectKey/i.test(e?.name) ? "UNWRAP_FAILED" : "PROVIDER_ERROR");

export const PROVIDERS = { platform, local, kms };
export const getProvider = (id) => { const p = PROVIDERS[id]; if (!p) throw new KeyError("UNKNOWN_PROVIDER", `Unknown key provider "${id}".`, 400); return p; };
