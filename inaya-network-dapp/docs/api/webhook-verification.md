# Verifying Inaya webhooks

Every webhook delivery is signed. Verify the signature on the **raw request body** before you trust anything in it.

## What you receive

| Header | Meaning |
|---|---|
| `x-inaya-event` | Event type, for example `file.uploaded` |
| `x-inaya-delivery-id` | Unique per delivery. Store it and ignore repeats (retries reuse the same id) |
| `x-inaya-timestamp` | Unix seconds when the delivery was signed |
| `x-inaya-signature` | `t=<timestamp>,v1=<hex>` and, during a secret rotation, a second `v1=<hex>` |

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`, hex encoded. The secret starts with `whsec_` and is shown once, when the endpoint is created or its secret is rotated.

## Rules for a receiver

1. Read the raw body as a string. Do not parse and re-serialize it first.
2. Split the signature header into `t` and every `v1` value.
3. Reject the delivery if `t` is more than five minutes from your clock (replay protection).
4. Compute the HMAC and compare in constant time against **each** `v1`. Accept if any match.
5. Return a `2xx` quickly. Anything else is retried after 1, 5, 15, 60, 240 and 720 minutes, after which the delivery is listed as dead letter. An endpoint that fails 20 deliveries in a row is paused automatically.
6. Deduplicate on `x-inaya-delivery-id`.

## Secret rotation

Rotating creates a new secret and keeps the old one valid for 24 hours. During that window each delivery carries two `v1` values, so a receiver that has either secret verifies correctly. Deploy the new secret, then let the old one expire.

## Using the SDK

```js
import { Webhooks } from "@inaya-network/custody-sdk";

const ok = await Webhooks.verify({
  secret: process.env.INAYA_WEBHOOK_SECRET,
  rawBody,                                   // the exact string you received
  signatureHeader: req.headers["x-inaya-signature"],
  // toleranceSeconds: 300                   // default
});
if (!ok) return res.status(400).end();
```

## Without the SDK (Node)

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret, now = Date.now()) {
  const parts = header.split(",");
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === want.length && timingSafeEqual(b, want); });
}
```

## What events contain

Events carry identifiers and states, never file contents, content keys, passwords or share tokens. Chat events are metadata only (no message text, no participants' keys) and must be switched on per endpoint. Email, push and webhook channels for notifications carry generic text only.

Event types: `file.uploaded`, `file.updated`, `file.deleted`, `file.lifecycle_expired`, `share.created`, `share.revoked`, `file_request.received`, `dlp.decision`, `backup.event`, `ransomware.signal`, `device.revoked`, `workflow.event`, `resilience.event`, `chat.metadata`.
