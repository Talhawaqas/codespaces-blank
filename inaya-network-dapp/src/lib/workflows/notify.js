// src/lib/workflows/notify.js
//
// SOW §18, §30, §43, §57: notification nodes. Inaya-native channels come first
// and reuse the existing infrastructure: createNotification() (with its unique
// dedupeKey, so a workflow retry cannot create a second notification) and
// sendEmail(). Slack and Gmail are the genuine gaps: nothing in the repository
// could send to either. Both are implemented, mock-tested and clearly labeled
// UNVERIFIED against the real services.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { connectToDatabase } from "../mongodb.js";
import { createNotification } from "../notifications.js";
import { sendEmail } from "../email.js";
import { decryptIntegrationSecret } from "../integrationCrypto.js";
import { redactPII } from "../aiSecurity/piiDetector.js";
import { renderTemplate } from "./expr.js";
import { resolveCredential } from "./credentials.js";
import { claimEffect, completeEffect, releaseEffect, releaseFailedEffect, effectKey } from "./effects.js";
import { redact } from "./common.js";

let fetchImpl = (...a) => globalThis.fetch(...a);
/** Test seam only: lets tests point Slack/Gmail at a local mock. Never used in production paths. */
export function __setNotifyFetch(fn) { fetchImpl = fn || ((...a) => globalThis.fetch(...a)); }

export const NOTIFY_CHANNELS = { "notify.inaya": "inaya", "notify.email": "email", "notify.slack": "slack", "notify.gmail": "gmail" };

/** SOW §30: workflowId + workflowVersion + executionDate + alertType + entityId. */
export function notificationDedupeKey({ workflowId, version, executionDate, alertType = "alert", entityId = "all" }) {
  return `wf:${workflowId}:v${version}:${executionDate}:${alertType}:${entityId}`;
}

function clean(text, { external = false, secrets = [] } = {}) {
  let t = redact(String(text ?? ""), { secrets });
  if (external) t = redactPII(t).text ?? redactPII(t);
  return typeof t === "string" ? t.slice(0, 3000) : String(t).slice(0, 3000);
}

async function orgMemberEmails(orgId, { managersOnly = false } = {}) {
  const { orgMembers } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), status: "active" };
  if (managersOnly) q.role = { $in: ["owner", "admin"] };
  return (await orgMembers.find(q).project({ email: 1 }).toArray()).map((m) => m.email);
}

/** Resolves + validates recipients. Non-members are refused unless the workflow allows external recipients. */
export async function resolveRecipients({ orgId, config, settings }) {
  const explicit = Array.isArray(config.recipients) ? config.recipients.map((r) => String(r).toLowerCase().trim()) : [];
  if (config.audience === "managers") explicit.push(...(await orgMemberEmails(orgId, { managersOnly: true })));
  if (config.audience === "all") explicit.push(...(await orgMemberEmails(orgId)));
  const members = new Set((await orgMemberEmails(orgId)).map((e) => e.toLowerCase()));
  const out = []; const refused = [];
  for (const r of [...new Set(explicit)]) { if (members.has(r) || settings?.allowExternalRecipients === true) out.push(r); else refused.push(r); }
  return { recipients: out, refused };
}

/**
 * Runs one notification node. ctx: { orgId, workflow:{id,version,name}, executionId, nodeKey, scope, settings, mode, secrets, actorEmail }
 * Returns { output } with per-recipient delivery status (SOW §18 "delivery status").
 */
export async function runNotifyNode(type, config, ctx) {
  const channel = NOTIFY_CHANNELS[type];
  const { orgId, workflow, executionId, nodeKey, scope, settings, mode, secrets } = ctx;
  const title = clean(renderTemplate(config.title || config.subject || "", scope), { external: channel !== "inaya", secrets: [...secrets] });
  const body = clean(renderTemplate(config.body || "", scope), { external: channel !== "inaya", secrets: [...secrets] });
  const severity = config.severity || "info";
  const alertType = renderTemplate(config.alertType || nodeKey, scope).slice(0, 40) || nodeKey;
  const entityId = renderTemplate(config.entityId || "all", scope).slice(0, 80) || "all";
  const executionDate = (ctx.executionDate || new Date().toISOString()).slice(0, 10);
  const dedupe = notificationDedupeKey({ workflowId: workflow.id, version: workflow.version, executionDate, alertType, entityId });
  const link = `/business?view=workflows&execution=${executionId}`;

  const { recipients, refused } = channel === "slack" ? { recipients: [], refused: [] } : await resolveRecipients({ orgId, config: { ...config, recipients: channel === "inaya" ? config.recipients : config.recipients }, settings });
  if (refused.length) throw Object.assign(new Error(`Recipient(s) not in this organization: ${refused.join(", ")}. Enable external recipients in the workflow permissions to send outside the organization.`), { retryable: false, code: "RECIPIENT_REFUSED" });

  if (mode !== "production") {
    return { output: { simulated: true, channel, wouldSend: { title, body: body.slice(0, 300), severity, recipients: channel === "inaya" && !recipients.length ? "all members" : recipients, dedupeKey: dedupe }, delivered: 0 } };
  }

  const deliveries = [];

  if (channel === "inaya") {
    const targets = recipients.length ? recipients : [null]; // null = every member (createNotification's org-wide form)
    for (const t of targets) {
      const key = t ? `${dedupe}:${t}` : dedupe;
      const { db } = await connectToDatabase();
      const already = await db.collection("notifications").findOne({ dedupeKey: key }, { projection: { _id: 1 } });
      await createNotification({
        scope: "org", orgId, targetEmail: t, category: "business", severity, type: "workflow_alert", title, body,
        sourceModule: "workflows", sourceId: executionId, actionUrl: link,
        metadata: { workflowId: workflow.id, workflowVersion: workflow.version, executionId, alertType, entityId }, dedupeKey: key,
      });
      deliveries.push({ recipient: t || "all members", status: already ? "DEDUPED" : "DELIVERED" });
    }
    return { output: { channel, delivered: deliveries.filter((d) => d.status === "DELIVERED").length, deliveries, dedupeKey: dedupe } };
  }

  // External channels: claim-before-send, at-most-once.
  const sendOne = async (recipientLabel, send) => {
    const key = effectKey(dedupe, channel, recipientLabel);
    let claim = await claimEffect({ orgId, key, kind: `notify.${channel}`, executionId, nodeKey, meta: { recipient: recipientLabel, alertType } });
    // A prior attempt that the provider explicitly REJECTED (state FAILED) verifiably did not deliver, so a retry may try again.
    // A claim with no recorded outcome (a crash mid-send) is UNCERTAIN and is never re-sent: at-most-once beats a duplicate.
    if (!claim.claimed && claim.effect?.state === "FAILED") { await releaseFailedEffect({ orgId, key }); claim = await claimEffect({ orgId, key, kind: `notify.${channel}`, executionId, nodeKey, meta: { recipient: recipientLabel, alertType, retry: true } }); }
    if (!claim.claimed) {
      deliveries.push({ recipient: recipientLabel, status: claim.effect?.state === "DONE" ? "DEDUPED" : "UNCERTAIN" });
      return;
    }
    try {
      const res = await send();
      await completeEffect({ orgId, key, state: res.ok ? "DONE" : "FAILED", result: { status: res.status || null, reason: res.reason || null } });
      deliveries.push({ recipient: recipientLabel, status: res.ok ? "DELIVERED" : "FAILED", reason: res.reason || null });
    } catch (err) {
      await completeEffect({ orgId, key, state: "FAILED", result: { error: String(err.message).slice(0, 200) } });
      deliveries.push({ recipient: recipientLabel, status: "FAILED", reason: String(err.message).slice(0, 200) });
    }
  };

  if (channel === "email") {
    for (const to of recipients) {
      await sendOne(to, async () => {
        const r = await sendEmail({ to, subject: title, html: `<p>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p><p><a href="${link}">Open in Inaya</a></p>`, text: `${body}\n\nOpen in Inaya: ${link}` });
        return { ok: r.sent === true, reason: r.reason || null };
      });
    }
  } else if (channel === "slack") {
    let webhook = null; let token = null;
    if (config.credentialId) {
      const cred = await resolveCredential({ orgId, credentialId: config.credentialId, providerWanted: ["slack_webhook"], executionId, nodeKey, actorEmail: ctx.actorEmail });
      if (cred.error) throw Object.assign(new Error(cred.error), { retryable: false, code: cred.reasonCode });
      webhook = cred.secret.url; secrets.add(webhook);
    } else if (config.integration === "slack") {
      const { integrationConnections } = await getOrgCollections();
      const conn = await integrationConnections.findOne({ orgId: toObjectId(orgId), providerId: "slack", status: "ACTIVE" });
      if (!conn?.credentialsEncrypted) throw Object.assign(new Error("Slack is not connected for this organization."), { retryable: false, code: "SLACK_NOT_CONNECTED" });
      token = JSON.parse(decryptIntegrationSecret(conn.credentialsEncrypted)).accessToken; secrets.add(token);
      if (!config.channel) throw Object.assign(new Error("A Slack channel is required."), { retryable: false });
    }
    const text = `*${severity.toUpperCase()}* ${title}\n${body}\n<${link}|Open in Inaya>`;
    await sendOne(config.channel || "slack-webhook", async () => {
      const res = webhook
        ? await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), redirect: "manual" })
        : await fetchImpl("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ channel: config.channel, text, thread_ts: config.threadTs || undefined }), redirect: "manual" });
      if (!res.ok) return { ok: false, status: res.status, reason: `Slack answered ${res.status}` };
      if (token) { const j = await res.json().catch(() => ({})); if (!j.ok) return { ok: false, status: res.status, reason: `Slack error: ${j.error || "unknown"}` }; }
      return { ok: true, status: res.status };
    });
  } else if (channel === "gmail") {
    const cred = await resolveCredential({ orgId, credentialId: config.credentialId, providerWanted: ["gmail_oauth"], executionId, nodeKey, actorEmail: ctx.actorEmail });
    if (cred.error) throw Object.assign(new Error(cred.error), { retryable: false, code: cred.reasonCode });
    // The short-lived token is minted lazily, only when a message is actually about to be sent (not for deduped repeats).
    let accessToken = cred.secret.accessToken || null;
    const getAccessToken = async () => {
      if (accessToken) return accessToken;
      if (!cred.secret.refreshToken) throw Object.assign(new Error("The Gmail credential has no usable token."), { retryable: false, code: "GMAIL_AUTH_FAILED" });
      for (const v of [cred.secret.refreshToken, cred.secret.clientSecret]) secrets.add(v);
      const tr = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cred.secret.clientId, client_secret: cred.secret.clientSecret, refresh_token: cred.secret.refreshToken, grant_type: "refresh_token" }).toString(), redirect: "manual" });
      if (!tr.ok) throw Object.assign(new Error(`Google refused to issue a Gmail access token (${tr.status}). The refresh token may have been revoked; reconnect Gmail.`), { retryable: tr.status >= 500, code: "GMAIL_AUTH_FAILED" });
      accessToken = (await tr.json().catch(() => ({}))).access_token;
      if (!accessToken) throw Object.assign(new Error("Google did not return an access token."), { retryable: false, code: "GMAIL_AUTH_FAILED" });
      secrets.add(accessToken);
      return accessToken;
    };
    if (accessToken) secrets.add(accessToken);
    for (const to of recipients) {
      await sendOne(to, async () => {
        const mime = [`To: ${to}`, `Subject: ${title.replace(/[\r\n]/g, " ")}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", `${body}\n\nOpen in Inaya: ${link}`].join("\r\n");
        const token = await getAccessToken();
        const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }), redirect: "manual" });
        return { ok: res.ok, status: res.status, reason: res.ok ? null : `Gmail answered ${res.status}` };
      });
    }
  }

  const failed = deliveries.filter((d) => d.status === "FAILED");
  if (failed.length && failed.length === deliveries.length) throw Object.assign(new Error(`Delivery failed: ${failed[0].reason || "unknown"}`), { retryable: true, code: "DELIVERY_FAILED", partial: { channel, deliveries } });
  return { output: { channel, delivered: deliveries.filter((d) => d.status === "DELIVERED").length, deliveries, dedupeKey: dedupe, unverified: channel === "slack" || channel === "gmail" ? "not tested against the live service" : undefined } };
}

export { releaseEffect };
