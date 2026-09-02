// src/lib/smsProviders/index.js
//
// Registry of SMS-provider adapters, each implementing the same small interface:
//   sendSms(phoneNumber, message) -> { sid }
//   isConfigured() -> boolean
//
// Same shape as pinningProviders/index.js (Backup mechanism) — one place
// mfa.js calls through without knowing which concrete provider backs it.
// Two today (Twilio, AWS SNS — added when Twilio's own onboarding
// wouldn't accept a given number); the interface exists so either can be
// added/swapped the same way Filebase was added alongside Pinata,
// without touching mfa.js itself.
//
// SELECTION: an explicit SMS_PROVIDER env var wins if set; otherwise the
// first provider (in PROVIDER_ORDER below) whose isConfigured() is true
// is used automatically — so setting up AWS SNS's three env vars alone
// is enough to switch delivery over, no separate "which provider" flag
// required unless you deliberately want to pin one down (e.g. both are
// configured and you want Twilio to stay authoritative).

import * as twilio from "./twilio.js";
import * as awsSns from "./awsSns.js";

export const SMS_PROVIDERS = { twilio, "aws-sns": awsSns };
const PROVIDER_ORDER = ["twilio", "aws-sns"];

export function getSmsProvider(name) {
  const resolvedName = name || process.env.SMS_PROVIDER || PROVIDER_ORDER.find((n) => SMS_PROVIDERS[n].isConfigured()) || PROVIDER_ORDER[0];
  const provider = SMS_PROVIDERS[resolvedName];
  if (!provider) throw new Error(`smsProviders: unknown provider "${resolvedName}" — expected one of: ${Object.keys(SMS_PROVIDERS).join(", ")}`);
  return provider;
}

export function isSmsConfigured() {
  return getSmsProvider().isConfigured();
}
