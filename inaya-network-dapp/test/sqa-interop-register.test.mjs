// SQA-006 regression test: interop (Wormhole) registration validates its input, is idempotent per source transaction and rate limited.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { POST as interopInitiate } from "../src/app/api/interop/wtt/initiate/route.js";
import { getInteropTransferCollections } from "../src/lib/interopTransfers.js";
import clientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const interopHashes = [];
after(async () => {
  try { const { transfers } = await getInteropTransferCollections(); await transfers.deleteMany({ sourceTxHash: { $in: interopHashes } }); const { db } = await connectToDatabase(); await db.collection("rate_limit_hits").deleteMany({ action: "interop:wtt-initiate", key: "sqa-test-ip" }); } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});
const rnd = () => ethers.hexlify(ethers.randomBytes(32));

test("interop registration validates input, is idempotent per source transaction and rate limited", async () => {
  const mk = (b) => new Request("http://localhost/api/interop/wtt/initiate", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "sqa-test-ip" }, body: JSON.stringify(b) });
  const tx = rnd(); interopHashes.push(tx);
  const good = { sourceChain: "BSC", destChain: "ETHEREUM", sourceTxHash: tx, userAddress: "0x00000000000000000000000000000000000000cc", amount: "1.5" };
  assert.equal((await interopInitiate(mk({ ...good, sourceTxHash: "0x1234" }))).status, 400);
  assert.equal((await interopInitiate(mk({ ...good, userAddress: "nope" }))).status, 400);
  assert.equal((await interopInitiate(mk({ ...good, amount: "-1" }))).status, 400);
  const a = await (await interopInitiate(mk(good))).json(); const b = await (await interopInitiate(mk(good))).json();
  assert.equal(a.success, true, JSON.stringify(a)); assert.equal(b.transferId, a.transferId, "the same source transaction registers once"); assert.equal(b.existing, true);
});
