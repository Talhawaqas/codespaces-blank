// src/adapters/gcs.js -- Google Cloud Storage source adapter (SOW §4.4
// GCS: "Support the already-proven GCS-compatible XML API path first...
// must not assume Google-native OAuth/service-account workflows are part
// of the current Inaya compatibility surface unless separately
// implemented and validated"). GCS's XML API is deliberately
// S3-interoperable (proven server-side in the Google Cloud Storage
// Compatibility Layer SOW's own AWS4-HMAC-SHA256 interop mode) -- so this
// is literally the same AWS S3 client as aws.js, pointed at
// storage.googleapis.com with an HMAC key pair instead of a native
// Google credential. No separate GCS client library, no OAuth/service-
// account code -- that surface is explicitly out of scope here.

import { createAwsSource } from "./aws.js";

export function createGcsSource({ hmacAccessId, hmacSecret, bucket, endpoint }) {
  return {
    ...createAwsSource({
      region: "auto",
      accessKeyId: hmacAccessId,
      secretAccessKey: hmacSecret,
      bucket,
      endpoint: endpoint || "https://storage.googleapis.com",
      forcePathStyle: true, // GCS's XML API supports path-style addressing; virtual-hosted (BUCKET.storage.googleapis.com) is explicitly out of scope per the GCS Compatibility SOW.
    }),
    kind: "gcs",
  };
}
