// src/report.js
//
// Reports job-level start/complete/fail events to Inaya's existing audit
// chain via the `?migration-log` sub-resource (see
// src/app/api/s3/[bucket]/route.js on the server side). This is the one
// call in this whole CLI that isn't a plain object read/write, so it
// isn't shaped for @aws-sdk/client-s3's own commands -- a small, real
// AWS4-HMAC-SHA256 signer, the same algorithm this session has already
// verified multiple times end-to-end against this exact server.
//
// Reporting is best-effort and never fails a migration run: the
// operator's local manifest (src/manifest.js) is the real source of
// truth for what migrated, not this breadcrumb.

import { createHmac, createHash } from "node:crypto";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sign({ method, host, path, bodyBuffer, accessKeyId, secretAccessKey }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "us-east-1", service = "s3";
  const payloadHash = sha256Hex(bodyBuffer);
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, path, "migration-log=", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest))].join("\n");
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: { Authorization: authorization, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash } };
}

/** `endpoint` is the full Inaya S3-compat endpoint (e.g.
 *  http://localhost:3000/api/s3) -- the same one used for the migration
 *  itself. Never throws; a reporting failure is logged and swallowed. */
export async function reportMigrationEvent({ endpoint, accessKeyId, secretAccessKey, bucket, jobId, event, summary }) {
  try {
    const url = new URL(endpoint);
    const path = `${url.pathname.replace(/\/$/, "")}/${bucket}`;
    const bodyBuffer = Buffer.from(JSON.stringify({ jobId, event, summary }));
    const { headers } = sign({ method: "PUT", host: url.host, path, bodyBuffer, accessKeyId, secretAccessKey });
    const resp = await fetch(`${url.origin}${path}?migration-log`, { method: "PUT", headers, body: bodyBuffer });
    if (!resp.ok) {
      console.warn(`(note: migration-log report to Inaya's audit trail did not succeed: ${resp.status} -- this does not affect the migration itself)`);
    }
  } catch (err) {
    console.warn(`(note: migration-log report to Inaya's audit trail failed: ${err.message} -- this does not affect the migration itself)`);
  }
}
