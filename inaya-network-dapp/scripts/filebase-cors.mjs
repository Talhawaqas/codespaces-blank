// scripts/filebase-cors.mjs — sets (or shows, or removes) the Filebase bucket's CORS rule that lets
// browsers upload Business Workspace file pieces straight to the bucket through short-lived signed
// links (chunked large-file uploads, Nov 2026). Server-side S3 calls ignore CORS, so backups and
// replicas are unaffected.
//   node --env-file=.env.local scripts/filebase-cors.mjs show|set|remove
import { S3Client, GetBucketCorsCommand, PutBucketCorsCommand, DeleteBucketCorsCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "https://s3.filebase.io", region: "auto", forcePathStyle: true,
  credentials: { accessKeyId: process.env.FILEBASE_ACCESS_KEY, secretAccessKey: process.env.FILEBASE_SECRET_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
});
const Bucket = process.env.FILEBASE_BUCKET;
const RULE = {
  AllowedOrigins: ["https://www.inayanetwork.com", "https://inayanetwork.com", "http://localhost:3000"],
  AllowedMethods: ["PUT", "GET"], // GET: readers download pieces through signed links
  AllowedHeaders: ["content-type"],
  ExposeHeaders: ["x-amz-meta-cid", "etag"],
  MaxAgeSeconds: 3600,
};

const show = async () => {
  try { console.log(JSON.stringify((await s3.send(new GetBucketCorsCommand({ Bucket }))).CORSRules, null, 2)); }
  catch (e) { console.log(e.name === "NoSuchCORSConfiguration" ? "no CORS rule" : `${e.name} ${e.$metadata?.httpStatusCode}`); }
};
const cmd = process.argv[2] || "show";
if (cmd === "set") await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [RULE] } }));
if (cmd === "remove") await s3.send(new DeleteBucketCorsCommand({ Bucket }));
await show();
