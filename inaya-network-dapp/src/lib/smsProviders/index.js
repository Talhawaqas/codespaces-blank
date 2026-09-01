// src/lib/smsProviders/index.js
//
// Registry of SMS-provider adapters, each implementing the same small interface:
//   sendSms(phoneNumber, message) -> { sid }
//   isConfigured() -> boolean
//
// Same shape as pinningProviders/index.js (Backup mechanism) — one place
// mfa.js calls through without knowing which concrete provider backs it.
// Only Twilio today; the interface exists so a second provider can be
// added the same way Filebase was added alongside Pinata, without
// touching mfa.js itself.

import * as twilio from "./twilio.js";

export const SMS_PROVIDERS = { twilio };

export function getSmsProvider(name = "twilio") {
  const provider = SMS_PROVIDERS[name];
  if (!provider) throw new Error(`smsProviders: unknown provider "${name}" — expected one of: ${Object.keys(SMS_PROVIDERS).join(", ")}`);
  return provider;
}

export function isSmsConfigured() {
  return getSmsProvider().isConfigured();
}
