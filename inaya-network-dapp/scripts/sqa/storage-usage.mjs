// scripts/sqa/storage-usage.mjs — read-only: how full the two pinning providers are.
//   node --env-file=.env.local scripts/sqa/storage-usage.mjs
// Prints counts and sizes only (never credentials or response text; Pinata echoes keys in errors).
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "https://s3.filebase.io", region: "auto", forcePathStyle: true,
  credentials: { accessKeyId: process.env.FILEBASE_ACCESS_KEY, secretAccessKey: process.env.FILEBASE_SECRET_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
});
let n = 0, bytes = 0, tok;
const prefixes = {};
do {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.FILEBASE_BUCKET, ContinuationToken: tok }));
  for (const o of r.Contents || []) { n++; bytes += o.Size || 0; const p = o.Key.split(/[/_]/)[0]; prefixes[p] = (prefixes[p] || 0) + 1; }
  tok = r.IsTruncated ? r.NextContinuationToken : undefined;
} while (tok);
console.log("filebase objects:", n, "MB:", (bytes / 1048576).toFixed(1), "by prefix:", JSON.stringify(Object.fromEntries(Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 8))));

const jwt = (process.env.PINATA_JWT || process.env.PINATA_SECRET_API_KEY || "").trim();
const u = await fetch("https://api.pinata.cloud/data/userPinnedDataTotal", { headers: { Authorization: `Bearer ${jwt}` } });
const j = await u.json().catch(() => ({}));
console.log("pinata status:", u.status, "pins:", j.pin_count ?? "?", "MB:", j.pin_size_total ? (j.pin_size_total / 1048576).toFixed(1) : "?");
