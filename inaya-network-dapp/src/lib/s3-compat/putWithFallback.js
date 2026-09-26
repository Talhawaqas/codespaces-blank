// src/lib/s3-compat/putWithFallback.js
//
// A thin resilience wrapper around the existing putS3Object: if the
// preferred pinning provider rejects the write (an outage, or an exhausted
// plan -- a real failure seen in this environment: Pinata HTTP 403 "plan
// usage limit"), try every other configured provider in turn.
//
// putS3Object pins BEFORE it writes any database row, so a failed attempt
// leaves nothing behind. This is the same behaviour Document Automation's
// storeDocumentBytes has; it lives here so NAS backup reuses it instead of
// copying it. It adds no new storage path -- only ordering and retry.

import { putS3Object } from "./store.js";
import { listAvailableProviders } from "../pinningProviders/index.js";

export async function putS3ObjectWithFallback(args) {
  const configured = listAvailableProviders();
  const attempts = configured.length ? [...configured].sort((a, b) => (a === "pinata" ? -1 : b === "pinata" ? 1 : 0)) : [undefined];
  let lastError;
  for (const providerName of attempts) {
    try {
      const obj = await putS3Object({ ...args, providerName });
      return { obj, providerName: providerName || "default", fallbackUsed: providerName !== attempts[0] };
    } catch (err) {
      lastError = err;
      console.error(`putS3ObjectWithFallback: provider "${providerName || "default"}" failed (${String(err.message).slice(0, 120)}); trying the next one`);
    }
  }
  throw lastError;
}
