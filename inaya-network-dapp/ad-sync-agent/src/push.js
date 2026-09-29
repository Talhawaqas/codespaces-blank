// ad-sync-agent/src/push.js
//
// Pushes one real AD user record to Inaya's existing identity webhook
// (src/app/api/integrations/identity/webhooks/[provider]/route.js),
// signed exactly the way that route verifies: X-Inaya-Signature = hex
// HMAC-SHA256(signingSecret, `${timestamp}.${rawBody}`), timestamp in
// whole seconds. This is the ONLY outbound call this agent makes to
// Inaya -- there is no inbound path, matching the SOW's "reaches out
// from inside the customer's network, never the other way" requirement.

import { createHmac } from "node:crypto";

function signPayload(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** rawAdUser: the object ldap.js's fetchUsers() returns for one AD user.
 *  Wrapped as { ad: {...} } to match normalize.js's fromAd(), which
 *  reads `b.ad || b.user || b`. eventId is deterministic (objectGUID +
 *  uSNChanged) so a retried push of the same observed state is a real
 *  no-op duplicate on the server, not a fabricated new event. tenantId
 *  MUST exactly equal the provider's own providerTenantId -- the engine
 *  rejects any mismatch as TENANT_MISMATCH, a real security check
 *  against cross-tenant event injection (src/lib/identity/engine.js). */
function buildEventBody(rawAdUser, tenantId) {
  const eventId = `ad:${rawAdUser.objectGUID}:${rawAdUser.uSNChanged}`;
  return { eventId, tenantId, ad: rawAdUser };
}

export async function pushUser({ inayaBaseUrl, providerId, signingSecret, tenantId, rawAdUser, fetchImpl = fetch }) {
  const body = JSON.stringify(buildEventBody(rawAdUser, tenantId));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signPayload(signingSecret, timestamp, body);
  const url = `${inayaBaseUrl.replace(/\/$/, "")}/api/integrations/identity/webhooks/${providerId}`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Inaya-Timestamp": timestamp,
      "X-Inaya-Signature": signature,
    },
    body,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { httpStatus: res.status, body: json };
}
