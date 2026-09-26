// docs/identity-integration/examples/sign-and-send.mjs
//
// Sends ONE signed lifecycle event to Inaya with nothing but node:crypto and fetch, so you can test a connection from any machine.
//   INAYA_BASE_URL=https://your-host INAYA_PROVIDER_ID=... INAYA_SIGNING_SECRET=idw_... INAYA_TENANT_ID=... node sign-and-send.mjs
// Webhooks are always live: this sends a real "user.updated" event. For a preview that changes nothing, call the API's /dry-run endpoint
// with a service credential (see the Rewst reference workflows).
import { createHmac, randomUUID } from "node:crypto";

const { INAYA_BASE_URL, INAYA_PROVIDER_ID, INAYA_SIGNING_SECRET, INAYA_TENANT_ID } = process.env;
if (!INAYA_BASE_URL || !INAYA_PROVIDER_ID || !INAYA_SIGNING_SECRET || !INAYA_TENANT_ID) { console.error("Set INAYA_BASE_URL, INAYA_PROVIDER_ID, INAYA_SIGNING_SECRET and INAYA_TENANT_ID."); process.exit(1); }

const event = {
  eventId: `sample-${randomUUID()}`,
  type: "user.updated",
  tenantId: INAYA_TENANT_ID,
  occurredAt: new Date().toISOString(),
  subject: { externalId: process.env.SAMPLE_OBJECT_ID || "sample-object-id", upn: "sample.user@corp.example", email: "sample.user@corp.example", department: "Finance", groups: ["Inaya-Finance"], accountEnabled: true },
};
const rawBody = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000);
const signature = `v1=${createHmac("sha256", INAYA_SIGNING_SECRET).update(`${timestamp}.${rawBody}`).digest("hex")}`;

const res = await fetch(`${INAYA_BASE_URL.replace(/\/$/, "")}/api/integrations/identity/webhooks/${INAYA_PROVIDER_ID}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Inaya-Timestamp": String(timestamp), "X-Inaya-Signature": signature },
  body: rawBody,
});
console.log(res.status, await res.text());
