// src/lib/smsProviders/awsSns.js
//
// UNWIRED: mfa.js's SMS method now runs on Firebase Phone Auth
// (firebaseAdmin.js/firebaseClient.js), which is a client-driven
// verification flow, not a sendSms(phoneNumber, message) adapter — this
// file's isConfigured()/sendSms() are no longer called from mfa.js. Left
// in place (real, tested code) rather than deleted, in case Firebase is
// ever swapped back out.
//
// AWS SNS direct-SMS integration — an alternative to twilio.js for MFA
// SMS delivery when Twilio's onboarding won't accept a given number.
// Same @aws-sdk/client-* family already used by pinningProviders/
// filebase.js (S3), so this follows that file's exact credential-object
// shape: { accessKeyId, secretAccessKey } + a region, read from env.
//
// DELIBERATELY SEPARATE env vars from any other AWS credentials in this
// app (AWS_SNS_ACCESS_KEY_ID / AWS_SNS_SECRET_ACCESS_KEY / AWS_SNS_REGION,
// not a shared AWS_ACCESS_KEY_ID) — same least-privilege, per-integration
// credential separation this codebase already keeps between PINATA_JWT
// and FILEBASE_ACCESS_KEY/FILEBASE_SECRET_KEY. Create a NARROWLY SCOPED
// IAM user for this (sns:Publish only) rather than reusing broader
// account credentials.
//
// SMSType "Transactional" (not "Promotional") is set explicitly on every
// send — this is what tells AWS to route an OTP through the
// highest-reliability/highest-cost path rather than the cheaper
// best-effort marketing one; getting this wrong silently degrades MFA
// code delivery.
//
// No AWS credentials were available to this session to prove a real send
// — same honest-gap situation twilio.js started in.

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

function getClient() {
  const accessKeyId = process.env.AWS_SNS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SNS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_SNS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) return null;
  return new SNSClient({ region, credentials: { accessKeyId, secretAccessKey } });
}

export function isConfigured() {
  return getClient() !== null;
}

export async function sendSms(phoneNumber, message) {
  const client = getClient();
  if (!client) {
    throw new Error("SMS delivery isn't configured yet — set AWS_SNS_ACCESS_KEY_ID, AWS_SNS_SECRET_ACCESS_KEY, and AWS_SNS_REGION to enable it.");
  }

  const command = new PublishCommand({
    PhoneNumber: phoneNumber,
    Message: message,
    MessageAttributes: {
      "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
    },
  });

  try {
    const result = await client.send(command);
    return { sid: result.MessageId };
  } catch (err) {
    throw new Error(err.message || "SMS send failed via AWS SNS.");
  }
}
