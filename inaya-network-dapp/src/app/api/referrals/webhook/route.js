// app/api/referrals/webhook/route.js
//
// POST /api/referrals/webhook — Didit fires this on every session status
// change. Handles two kinds of sessions, distinguished by the vendor_data
// prefix WE set when creating them (server-controlled, so trustworthy —
// Didit just echoes it back, it isn't user input):
//   "activation:<referrerId>" — a referrer's own one-time KYC
//   "referral:<referralId>"   — a referred person's KYC for a specific invite
//
// Security/idempotency, all confirmed against docs.didit.me rather than
// assumed (see src/lib/didit.js's header comment):
//   - Signature verified via X-Signature-V2 (canonical JSON) / X-Signature
//     (raw bytes) BEFORE the body is parsed for anything else.
//   - Idempotency key is the payload's `event_id` (a uuid), not session_id —
//     one session can fire multiple webhook events across its lifecycle.
//   - We re-fetch the decision via the API rather than trusting whatever
//     the webhook body embeds, so the fraud checks always see the
//     canonical, authoritative id_verifications/status data.
//
// The actual fraud-check/crediting logic lives in
// ../../../../lib/referral-webhook-logic.js — factored out so it can be
// unit-tested with a synthetic decision object (see test/referral-webhook-logic.test.js)
// without needing a real Didit sandbox call for every test case.

import { NextResponse } from "next/server";
import { verifyDiditWebhook, getDiditDecision } from "../../../../lib/didit.js";
import { getReferralCollections, ensureReferralIndexes } from "../../../../lib/referrals.js";
import { handleActivationDecision, handleReferralDecision } from "../../../../lib/referral-webhook-logic.js";

export const maxDuration = 30;

export async function POST(req) {
  const rawBody = await req.text();

  const verification = await verifyDiditWebhook({ rawBody, headers: req.headers });
  if (!verification.valid) {
    console.error("referrals/webhook: signature verification failed:", verification.reason);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { event_id: eventId, session_id: sessionId, vendor_data: vendorData } = payload;
  if (!eventId || !sessionId || !vendorData) {
    return NextResponse.json({ error: "Missing event_id, session_id, or vendor_data" }, { status: 400 });
  }

  await ensureReferralIndexes();
  const { webhookEvents } = await getReferralCollections();

  // Atomic idempotency gate: a unique index on eventId means a duplicate
  // delivery (Didit's own retries, or a replay) throws E11000 here and we
  // just ack without reprocessing.
  try {
    await webhookEvents.insertOne({ eventId, sessionId, webhookType: payload.webhook_type || null, receivedAt: new Date().toISOString() });
  } catch (err) {
    if (err?.code === 11000) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    throw err;
  }

  try {
    const decision = await getDiditDecision(sessionId);

    if (vendorData.startsWith("activation:")) {
      await handleActivationDecision(vendorData.slice("activation:".length), decision);
    } else if (vendorData.startsWith("referral:")) {
      await handleReferralDecision(vendorData.slice("referral:".length), decision);
    } else {
      console.error("referrals/webhook: unrecognized vendor_data prefix:", vendorData);
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    // Processing failed after signature+idempotency passed — return 500 so
    // Didit's retry policy (per its own docs: ~1min then ~4min) gets another
    // shot. Safe to retry: the eventId row above only guards against
    // reprocessing a delivery we already SUCCEEDED on, not this one, since
    // we insert it before processing rather than after. If Didit doesn't
    // redeliver on 500, the /api/referrals/status endpoint's on-demand
    // decision fetch is the fallback path.
    console.error(`referrals/webhook: processing failed for event ${eventId}:`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
