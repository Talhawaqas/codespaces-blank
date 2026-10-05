// src/lib/keys/service.js
//
// Key custody service (Competitive Expansion SOW Q, KEY-001): per-organization key provider configuration, envelope handling for the server-managed S3/Azure layer's data key, rotation with
// key versions and active/retired/disabled states, a full operation audit, and failed-key-access telemetry.
//
// DEFAULT UNCHANGED. An organization with no configuration keeps the platform-managed behaviour exactly as before. Choosing a customer-managed provider RE-WRAPS the organization's data key
// under that provider and removes the platform-wrapped copy, so from that moment the platform alone cannot unwrap it. The provider is exercised with a throw-away probe key before anything
// changes, so a wrong ARN or a missing key is caught first. Providers only ever see the data key (a 48-byte passphrase), never file content.
//
// RECOVERY AND DESTRUCTION (documented in docs/architecture/customer-managed-keys.md): if the customer's key is destroyed, the data key cannot be unwrapped and everything the server-managed layer
// encrypted under it becomes permanently unreadable (crypto-shredding). That is the point, and also the risk: there is no Inaya-held copy to fall back on once the platform-wrapped copy is removed.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { KeyError, PROVIDER_IDS, getProvider, contextFor, environmentName, localKeys } from "./providers.js";

const nowIso = () => new Date().toISOString();
export const PURPOSE = "s3-owner-passphrase";
const cache = new Map(); const ttlMs = () => Math.max(0, Number(process.env.CMK_CACHE_SECONDS ?? 60)) * 1000;
export const clearCache = (orgId = null) => { if (orgId) cache.delete(String(orgId)); else cache.clear(); };

async function cols() { const { db } = await getOrgCollections(); const config = db.collection("org_key_config"), audit = db.collection("org_key_audit"); if (!cols.done) { await Promise.all([config.createIndex({ orgId: 1 }, { unique: true }), audit.createIndex({ orgId: 1, at: -1 })]); cols.done = true; } return { db, config, audit }; }
const record = async (orgId, op, { ok, code = null, keyRef = null, keyVersion = null, actor = null }) => { try { if (/^(wrap|unwrap)$/.test(op)) import("../metrics/metrics.js").then((m) => m.metric("keys.operation", { orgId, label: `${op}_${ok ? "ok" : "failed"}` })).catch(() => {}); const { audit } = await cols(); await audit.insertOne({ orgId: toObjectId(orgId), op, ok, code, keyRef, keyVersion, purpose: PURPOSE, environment: environmentName(), actor, at: nowIso() }); } catch { /* telemetry never blocks */ } };
const ownerOnly = (m) => { if (!canManageOrg(m) || !["owner"].includes(m?.role)) throw new KeyError("FORBIDDEN", "Only the organization owner can change key management.", 403); };

export async function getConfig(orgId) { const { config } = await cols(); const c = await config.findOne({ orgId: toObjectId(orgId) }); return c || { provider: "platform", state: "active", version: 0, keyRef: "platform", history: [] }; }
const view = (c) => ({ provider: c.provider, keyRef: c.keyRef, region: c.region || null, endpoint: c.endpoint ? "custom" : null, version: c.version, state: c.state, environment: c.environment || environmentName(), configuredAt: c.configuredAt || null, configuredBy: c.configuredBy || null, history: (c.history || []).map((h) => ({ version: h.version, provider: h.provider, keyRef: h.keyRef, state: h.state, from: h.from, to: h.to || null })) });

// ------------------------------------------------------------------------------------------------ wrap / unwrap for the data key
export async function wrapForOrg(orgId, passphrase) {
  const c = await getConfig(orgId); if (c.provider === "platform") return null; if (c.state !== "active") throw new KeyError("KEY_DISABLED", "Key management for this organization is disabled.");
  const p = getProvider(c.provider); const ctx = contextFor({ orgId, purpose: PURPOSE });
  try { const w = await p.wrap({ plaintext: Buffer.from(passphrase, "utf8"), context: ctx, keyRef: c.keyRef, options: { region: c.region, endpoint: c.endpoint } }); await record(orgId, "wrap", { ok: true, keyRef: w.keyRef, keyVersion: c.version }); return { provider: c.provider, keyRef: w.keyRef, keyVersion: c.version, environment: ctx.environment, ciphertext: w.ciphertext, wrappedAt: nowIso() }; }
  catch (e) { await record(orgId, "wrap", { ok: false, code: e.code || "ERROR", keyRef: c.keyRef }); throw e; }
}
export async function unwrapForOrg(orgId, envelope) {
  const hit = cache.get(String(orgId)); if (hit && hit.until > Date.now() && hit.ref === envelope.ciphertext) return hit.value;
  const c = await getConfig(orgId); if (c.state === "disabled") { await record(orgId, "unwrap", { ok: false, code: "KEY_DISABLED", keyRef: envelope.keyRef }); throw new KeyError("KEY_DISABLED", "Key management for this organization is disabled, so its data key cannot be unwrapped."); }
  if (envelope.environment && envelope.environment !== environmentName()) { await record(orgId, "unwrap", { ok: false, code: "ENV_MISMATCH", keyRef: envelope.keyRef, keyVersion: envelope.keyVersion }); throw new KeyError("ENV_MISMATCH", `This key was wrapped for the "${envelope.environment}" environment and cannot be used in "${environmentName()}".`); }
  const p = getProvider(envelope.provider); const ctx = contextFor({ orgId, purpose: PURPOSE, env: envelope.environment });
  try { const v = (await p.unwrap({ envelope, context: ctx, options: { region: c.region, endpoint: c.endpoint } })).toString("utf8"); await record(orgId, "unwrap", { ok: true, keyRef: envelope.keyRef, keyVersion: envelope.keyVersion }); if (ttlMs()) cache.set(String(orgId), { value: v, ref: envelope.ciphertext, until: Date.now() + ttlMs() }); return v; }
  catch (e) { await record(orgId, "unwrap", { ok: false, code: e.code || "ERROR", keyRef: envelope.keyRef, keyVersion: envelope.keyVersion }); throw e; }
}
async function ownerKeysDoc(orgId) { const { db } = await getOrgCollections(); return { col: db.collection("s3_owner_keys"), doc: await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: String(orgId) }) }; }
async function currentPassphrase(orgId, doc) { if (doc.keyEnvelope) return unwrapForOrg(orgId, doc.keyEnvelope); const { unwrapPassphrase } = await import("../s3-compat/crypto.js"); return unwrapPassphrase(doc.wrappedPassphrase); }

// ------------------------------------------------------------------------------------------------ administration
export async function status({ orgId, membership }) {
  if (!canManageOrg(membership) && !(membership?.adminRoles || []).some((r) => ["securityAdmin", "complianceAdmin", "auditor"].includes(r))) throw new KeyError("FORBIDDEN", "Only an owner, admin, security or compliance administrator or auditor can see key management.", 403);
  const c = await getConfig(orgId); const { audit } = await cols(); const since = new Date(Date.now() - 30 * 86400_000).toISOString(); const rows = await audit.find({ orgId: toObjectId(orgId), at: { $gt: since } }).sort({ at: -1 }).limit(2000).toArray();
  const byDay = {}; for (const r of rows) { const d = r.at.slice(0, 10); (byDay[d] ||= { ok: 0, failed: 0 })[r.ok ? "ok" : "failed"]++; } const lastFail = rows.find((r) => !r.ok); const { doc } = await ownerKeysDoc(orgId);
  return { config: view(c), dataKey: { exists: !!doc, protectedBy: doc ? (doc.keyEnvelope ? doc.keyEnvelope.provider : "platform") : null }, providers: [{ id: "platform", label: "Platform-managed key", available: !!process.env.S3_COMPAT_ENCRYPTION_KEY }, { id: "local", label: "Local key material", available: Object.keys(localKeys()).length > 0, keyIds: Object.keys(localKeys()) }, { id: "kms", label: "AWS KMS (customer-owned key)", available: true }], telemetry: { last30Days: byDay, operations: rows.length, failures: rows.filter((r) => !r.ok).length, lastFailure: lastFail ? { op: lastFail.op, code: lastFail.code, at: lastFail.at } : null }, cacheSeconds: ttlMs() / 1000, environment: environmentName(), warning: "If you destroy or revoke your key, data encrypted under it becomes permanently unreadable. Inaya keeps no copy once a customer key is in use." };
}
/** Moves the data key under a new provider/key. The probe round trip runs first; the old key must still work. Nothing changes unless every step succeeds. */
export async function configure({ orgId, membership, actorEmail, provider, keyRef, region = null, endpoint = null, acknowledgeDestruction = false }) {
  ownerOnly(membership); if (!PROVIDER_IDS.includes(provider)) throw new KeyError("UNKNOWN_PROVIDER", `provider must be one of ${PROVIDER_IDS.join(", ")}.`, 400);
  if (provider !== "platform") { if (!acknowledgeDestruction) throw new KeyError("ACK_REQUIRED", "Confirm that you understand destroying or revoking this key makes the data encrypted under it permanently unreadable (acknowledgeDestruction).", 400); if (!keyRef || String(keyRef).length > 2048) throw new KeyError("BAD_KEY_REF", "keyRef is required (a key id, ARN or alias).", 400); if (endpoint) { let u; try { u = new URL(endpoint); } catch { throw new KeyError("BAD_ENDPOINT", "endpoint is not a valid URL.", 400); } if (u.protocol !== "https:" && !(process.env.CMK_ALLOW_INSECURE_ENDPOINT === "1" && u.hostname === "127.0.0.1")) throw new KeyError("BAD_ENDPOINT", "The key service endpoint must be https.", 400); } }
  const p = getProvider(provider); const probe = await p.check({ keyRef, options: { region, endpoint } }); if (!probe.ok) { await record(orgId, "configure", { ok: false, code: "PROBE_FAILED", keyRef, actor: actorEmail }); throw new KeyError("PROBE_FAILED", `The key could not be used (${probe.detail || "check failed"}). Nothing was changed.`, 400); }
  const { config } = await cols(); const prev = await getConfig(orgId); const { col, doc } = await ownerKeysDoc(orgId); const nextVersion = (prev.version || 0) + 1;
  if (doc) { const pass = await currentPassphrase(orgId, doc); const next = { ...prev, provider, keyRef: provider === "platform" ? "platform" : keyRef, region, endpoint, version: nextVersion, state: "active" }; await config.updateOne({ orgId: toObjectId(orgId) }, { $set: { provider, keyRef: next.keyRef, region, endpoint, version: nextVersion, state: "active", environment: environmentName(), configuredAt: nowIso(), configuredBy: actorEmail }, $setOnInsert: { history: [] } }, { upsert: true }); clearCache(orgId);
    try { const env = await wrapForOrg(orgId, pass); if (env) await col.updateOne({ _id: doc._id }, { $set: { keyEnvelope: env, keyMigratedAt: nowIso() }, $unset: { wrappedPassphrase: "" } }); else { const { wrapPassphrase } = await import("../s3-compat/crypto.js"); await col.updateOne({ _id: doc._id }, { $set: { wrappedPassphrase: wrapPassphrase(pass), keyMigratedAt: nowIso() }, $unset: { keyEnvelope: "" } }); } }
    catch (e) { await config.updateOne({ orgId: toObjectId(orgId) }, { $set: { provider: prev.provider, keyRef: prev.keyRef, region: prev.region || null, endpoint: prev.endpoint || null, version: prev.version || 0, state: prev.state || "active" } }); clearCache(orgId); throw e; } }
  else await config.updateOne({ orgId: toObjectId(orgId) }, { $set: { provider, keyRef: provider === "platform" ? "platform" : keyRef, region, endpoint, version: nextVersion, state: "active", environment: environmentName(), configuredAt: nowIso(), configuredBy: actorEmail }, $setOnInsert: { history: [] } }, { upsert: true });
  await config.updateOne({ orgId: toObjectId(orgId) }, { $push: { history: { version: nextVersion, provider, keyRef: provider === "platform" ? "platform" : keyRef, state: "active", from: nowIso() } } }); if (prev.version) await config.updateOne({ orgId: toObjectId(orgId), "history.version": prev.version }, { $set: { "history.$.state": "retired", "history.$.to": nowIso() } });
  await record(orgId, "configure", { ok: true, keyRef: provider === "platform" ? "platform" : keyRef, keyVersion: nextVersion, actor: actorEmail }); await logOrgActivity({ orgId, recordType: "KEY_MANAGEMENT", recordId: new ObjectId(), actorEmail, action: "PROVIDER_SET", previousState: prev.provider, newState: provider, metadata: { keyRef: provider === "platform" ? "platform" : keyRef, version: nextVersion, dataKeyRewrapped: !!doc } }).catch(() => {});
  return status({ orgId, membership });
}
/** Rotation: same provider, a new key (or key id). The data key is re-wrapped under the new key; files are not re-encrypted. The old key version is marked retired. */
export async function rotate({ orgId, membership, actorEmail, keyRef, region, endpoint }) {
  ownerOnly(membership); const c = await getConfig(orgId); if (c.provider === "platform") throw new KeyError("NOT_APPLICABLE", "Rotation applies to a customer-managed key. Platform key rotation is an operator procedure.", 400);
  return configure({ orgId, membership, actorEmail, provider: c.provider, keyRef: keyRef || c.keyRef, region: region ?? c.region, endpoint: endpoint ?? c.endpoint, acknowledgeDestruction: true });
}
/** Inaya-side switch: stops this deployment using the key. It does not touch the customer's own key; destruction happens in the customer's key service. */
export async function setState({ orgId, membership, actorEmail, state }) {
  ownerOnly(membership); if (!["active", "disabled"].includes(state)) throw new KeyError("BAD_STATE", "state must be active or disabled.", 400); const c = await getConfig(orgId); if (c.provider === "platform") throw new KeyError("NOT_APPLICABLE", "There is no customer key to disable.", 400);
  const { config } = await cols(); await config.updateOne({ orgId: toObjectId(orgId) }, { $set: { state } }); clearCache(orgId); await record(orgId, state === "disabled" ? "disable" : "enable", { ok: true, keyRef: c.keyRef, actor: actorEmail });
  await logOrgActivity({ orgId, recordType: "KEY_MANAGEMENT", recordId: new ObjectId(), actorEmail, action: state === "disabled" ? "DISABLED" : "ENABLED", previousState: c.state, newState: state, metadata: { keyRef: c.keyRef } }).catch(() => {}); return status({ orgId, membership });
}
export async function listAudit({ orgId, membership, limit = 100 }) { await status({ orgId, membership }); const { audit } = await cols(); return { events: (await audit.find({ orgId: toObjectId(orgId) }).sort({ at: -1 }).limit(Math.min(Number(limit) || 100, 500)).toArray()).map((r) => ({ op: r.op, ok: r.ok, code: r.code, keyRef: r.keyRef, keyVersion: r.keyVersion, environment: r.environment, actor: r.actor, at: r.at })) }; }
