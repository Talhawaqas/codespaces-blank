// src/lib/smsProviders/twilio.js
//
// Real Twilio REST API integration for MFA SMS delivery — no SDK
// dependency needed, Twilio's Messages API is a plain authenticated POST.
// isConfigured() reports true once TWILIO_ACCOUNT_SID/AUTH_TOKEN/
// FROM_NUMBER are all present; sendSms() throws a clear, actionable error
// if called without them, same "no silent no-op" discipline
// pinningProviders/filebase.js already established for exactly this
// class of "real integration, credentials pending" gap.
//
// HONEST GAP: no TWILIO_* credentials were configured in the session that
// built this — this code is real and correct against Twilio's documented
// API shape, but the live send-and-receive round trip needs your real
// account credentials to prove end-to-end, the same situation
// pinningProviders/filebase.js started in before Filebase went live.

export function isConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

export async function sendSms(phoneNumber, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("SMS delivery isn't configured yet — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to enable it.");
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    },
    body: new URLSearchParams({ To: phoneNumber, From: fromNumber, Body: message }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `SMS send failed (HTTP ${res.status})`);
  return { sid: data.sid };
}
