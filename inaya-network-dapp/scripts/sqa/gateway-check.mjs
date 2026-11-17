// scripts/sqa/gateway-check.mjs — read-only: can the public IPFS gateways the readers use actually serve our shards?
// Takes one CID pinned at Pinata and one stored at Filebase, fetches each through every gateway, prints status + time.
//   node --env-file=.env.local scripts/sqa/gateway-check.mjs
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";

const jwt = (process.env.PINATA_JWT || process.env.PINATA_SECRET_API_KEY || "").trim();
const list = await fetch("https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1", { headers: { Authorization: `Bearer ${jwt}` } }).then((r) => r.json()).catch(() => ({}));
const pinataCid = list.rows?.[0]?.ipfs_pin_hash;

const s3 = new S3Client({ endpoint: "https://s3.filebase.io", region: "auto", forcePathStyle: true, credentials: { accessKeyId: process.env.FILEBASE_ACCESS_KEY, secretAccessKey: process.env.FILEBASE_SECRET_KEY }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
const first = (await s3.send(new ListObjectsV2Command({ Bucket: process.env.FILEBASE_BUCKET, MaxKeys: 5 }))).Contents?.find((o) => !o.Key.startsWith("ws/"));
const filebaseCid = first ? (await s3.send(new HeadObjectCommand({ Bucket: process.env.FILEBASE_BUCKET, Key: first.Key }))).Metadata?.cid : null;

const gateways = ["https://cloudflare-ipfs.com/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];
for (const [label, cid] of [["pinata-pinned", pinataCid], ["filebase-stored", filebaseCid]]) {
  if (!cid) { console.log(label, "no CID available"); continue; }
  for (const g of gateways) {
    const t = Date.now();
    let status;
    try { const r = await fetch(g + cid, { signal: AbortSignal.timeout(20000) }); status = r.status; await r.arrayBuffer(); } catch (e) { status = e.name === "TimeoutError" ? "timeout" : `error(${e.cause?.code || e.name})`; }
    console.log(label.padEnd(16), g.padEnd(38), String(status).padEnd(14), `${Date.now() - t}ms`);
  }
}
