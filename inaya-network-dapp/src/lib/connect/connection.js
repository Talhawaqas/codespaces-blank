// src/lib/connect/connection.js -- SOW B1/B2: one WhatsApp Business number per company (manual connection now; Embedded
// Signup later). The phone-number ID is globally unique (waKey), so a number can belong to exactly one Inaya company and
// inbound events are routed ONLY by it. Secrets (app secret, access token) are encrypted at rest and never returned.
// The webhook verify token is shown once and stored as a hash.
import { ccol, oid, sid, clean, fail, nowIso, K, connectAccess, ensureConnectIndexes, encryptIntegrationSecret, isIntegrationCryptoConfigured, digits, sha256, token, audit, maskPhone } from "./core.js";
import { phoneInfo, sendText, subscribeApp } from "./graph.js";

const view = (c) => c && ({ id: sid(c._id), status: c.status, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, displayNumber: c.displayNumber || null, verifiedName: c.verifiedName || null, quality: c.quality || null, connectedAt: c.connectedAt, connectedBy: c.connectedBy, lastInboundAt: c.lastInboundAt || null, lastOutboundAt: c.lastOutboundAt || null, lastError: c.lastError || null, webhookVerifiedAt: c.webhookVerifiedAt || null, wabaSubscribed: !!c.wabaSubscribed, mode: c.mode || "manual" });
export const webhookUrl = () => `${(process.env.NEXT_PUBLIC_SITE_URL || "https://www.inayanetwork.com").replace(/\/$/, "")}/api/connect/whatsapp`;

export async function getConnection(orgId) { const c = await ccol(); return c.findOne({ orgId: oid(orgId), kind: K.conn, status: { $in: ["ACTIVE", "PENDING_WEBHOOK"] } }); }
export async function connectionStatus({ orgId, membership }) {
  const d = await connectAccess({ orgId, membership }); if (d) return d;
  return { connection: view(await getConnection(orgId)), webhookUrl: webhookUrl() };
}

/** Manual connection: phone-number ID + WABA ID + app secret + system-user token from the company's own Meta setup.
 *  The token is checked against Meta before anything is saved. */
export async function connect({ orgId, membership, actorEmail, input = {} }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  if (!isIntegrationCryptoConfigured()) return fail("Secure storage for integration secrets isn't configured on this server.", 503);
  await ensureConnectIndexes();
  const phoneNumberId = digits(input.phoneNumberId); const wabaId = digits(input.wabaId);
  const appSecret = String(input.appSecret || "").trim(); const accessToken = String(input.accessToken || "").trim();
  if (phoneNumberId.length < 6 || wabaId.length < 6) return fail("Enter the Phone number ID and the WhatsApp Business Account ID from Meta's API Setup page.");
  if (!/^[a-f0-9]{32}$/i.test(appSecret)) return fail("The App secret is the 32-character value under App settings › Basic in your Meta app.");
  if (accessToken.length < 50) return fail("Paste the permanent system-user access token.");
  const c = await ccol();
  if (await getConnection(orgId)) return fail("This company already has a WhatsApp number connected. Disconnect it first.", 409);
  const probe = { phoneNumberId, accessTokenEncrypted: encryptIntegrationSecret(accessToken) };
  let info; try { info = await phoneInfo(probe); } catch (e) { return fail(`Meta didn't accept these details: ${String(e.message).slice(0, 200)}`, 400, "META_REJECTED"); }
  const verify = `icv_${token(18)}`; const now = nowIso();
  const doc = { orgId: oid(orgId), kind: K.conn, opsDoc: true, waKey: `pnid:${phoneNumberId}`, status: "PENDING_WEBHOOK", mode: "manual", phoneNumberId, wabaId, displayNumber: info?.display_phone_number || null, verifiedName: info?.verified_name || null, quality: info?.quality_rating || null,
    appSecretEncrypted: encryptIntegrationSecret(appSecret), accessTokenEncrypted: probe.accessTokenEncrypted, verifyTokenHash: sha256(verify), connectedAt: now, connectedBy: actorEmail, createdAt: now };
  try { const r = await c.insertOne(doc); doc._id = r.insertedId; }
  catch (e) {
    if (e?.code === 11000) {
      const prior = await c.findOne({ waKey: `pnid:${phoneNumberId}` });
      if (prior && String(prior.orgId) === String(orgId) && prior.status === "DISCONNECTED") { await c.updateOne({ _id: prior._id }, { $unset: { waKey: "" } }); return connect({ orgId, membership, actorEmail, input }); }
      return fail("This WhatsApp number is already connected to another company.", 409, "NUMBER_TAKEN");
    }
    throw e;
  }
  doc.wabaSubscribed = await linkApp(doc);
  await audit({ orgId, actorEmail, action: "CONNECT_NUMBER_CONNECTED", recordId: doc._id, metadata: { phoneNumberId, wabaId, display: maskPhone(doc.displayNumber) } });
  return { connection: view(doc), webhook: { callbackUrl: webhookUrl(), verifyToken: verify, fields: ["messages"], note: "Enter these in your Meta app (WhatsApp › Configuration › Webhook) and subscribe to 'messages'. The verify token is shown only once." } };
}
async function linkApp(conn) {
  const c = await ccol(); let ok = false, error = null;
  try { const r = await subscribeApp(conn); ok = r?.success !== false; } catch (e) { error = String(e.message).slice(0, 200); }
  await c.updateOne({ _id: conn._id }, { $set: { wabaSubscribed: ok, wabaSubscribedAt: ok ? nowIso() : null, ...(error ? { lastError: { at: nowIso(), message: `Couldn't link the WhatsApp account to the app: ${error}` } } : {}) } });
  return ok;
}
/** "Link to Meta": (re)attaches the WhatsApp Business Account to the app so incoming messages are delivered. */
export async function relinkApp({ orgId, membership, actorEmail }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const conn = await getConnection(orgId); if (!conn) return fail("No WhatsApp number is connected.", 404);
  const ok = await linkApp(conn); if (!ok) return fail("Meta didn't accept the link. Check that the access token has the whatsapp_business_management permission for this WhatsApp account.", 502);
  await audit({ orgId, actorEmail, action: "CONNECT_APP_LINKED", recordId: conn._id });
  return { ok: true };
}
export async function rotateVerifyToken({ orgId, membership, actorEmail }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const conn = await getConnection(orgId); if (!conn) return fail("No WhatsApp number is connected.", 404);
  const verify = `icv_${token(18)}`; const c = await ccol();
  await c.updateOne({ _id: conn._id }, { $set: { verifyTokenHash: sha256(verify), ...(conn.status === "ACTIVE" ? {} : { status: "PENDING_WEBHOOK", webhookVerifiedAt: null }) } });
  await audit({ orgId, actorEmail, action: "CONNECT_VERIFY_TOKEN_ROTATED", recordId: conn._id });
  return { webhook: { callbackUrl: webhookUrl(), verifyToken: verify } };
}
/** Update the access token (expired/rotated) without reconnecting. */
export async function updateToken({ orgId, membership, actorEmail, accessToken, appSecret }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const conn = await getConnection(orgId); if (!conn) return fail("No WhatsApp number is connected.", 404);
  const set = {};
  if (accessToken) { const probe = { phoneNumberId: conn.phoneNumberId, accessTokenEncrypted: encryptIntegrationSecret(String(accessToken).trim()) }; try { await phoneInfo(probe); } catch (e) { return fail(`Meta didn't accept the token: ${String(e.message).slice(0, 200)}`, 400); } set.accessTokenEncrypted = probe.accessTokenEncrypted; }
  if (appSecret) { if (!/^[a-f0-9]{32}$/i.test(String(appSecret).trim())) return fail("The App secret is 32 hexadecimal characters."); set.appSecretEncrypted = encryptIntegrationSecret(String(appSecret).trim()); }
  if (!Object.keys(set).length) return fail("Nothing to update.");
  const c = await ccol(); await c.updateOne({ _id: conn._id }, { $set: { ...set, lastError: null, updatedAt: nowIso() } });
  await audit({ orgId, actorEmail, action: "CONNECT_CREDENTIALS_UPDATED", recordId: conn._id, metadata: { token: !!accessToken, appSecret: !!appSecret } });
  return { ok: true };
}
/** Disconnect: secrets wiped immediately, the number freed, history kept. Stale credentials can't send or receive. */
export async function disconnect({ orgId, membership, actorEmail, reason }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const conn = await getConnection(orgId); if (!conn) return fail("No WhatsApp number is connected.", 404);
  const c = await ccol();
  await c.updateOne({ _id: conn._id }, { $set: { status: "DISCONNECTED", disconnectedAt: nowIso(), disconnectedBy: actorEmail, disconnectReason: clean(reason, 300) || null }, $unset: { appSecretEncrypted: "", accessTokenEncrypted: "", verifyTokenHash: "", waKey: "" } });
  await audit({ orgId, actorEmail, action: "CONNECT_NUMBER_DISCONNECTED", recordId: conn._id, metadata: { reason: clean(reason, 300) || null } });
  return { ok: true };
}
/** "Send a test message" to a number (must be a registered test recipient while the Meta app is in development). */
export async function testMessage({ orgId, membership, actorEmail, to }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const conn = await getConnection(orgId); if (!conn) return fail("No WhatsApp number is connected.", 404);
  const n = digits(to); if (n.length < 8) return fail("Enter the phone number with country code.");
  const { sendMessage } = await import("./messages.js");
  const r = await sendMessage({ orgId, conn, to: n, text: "This is a test message from Inaya Connect. Your WhatsApp number is connected.", actorEmail, category: "service", kind: "test" });
  if (r.error) return r;
  await audit({ orgId, actorEmail, action: "CONNECT_TEST_MESSAGE_SENT", recordId: conn._id, metadata: { to: maskPhone(n) } });
  return { ok: true, waMessageId: r.waMessageId, note: "If it doesn't arrive: while your Meta app is in development, the recipient must be added under WhatsApp › API Setup › To, and outside a 24-hour customer window Meta may require a template." };
}
export { view as connectionView };
void sendText;
