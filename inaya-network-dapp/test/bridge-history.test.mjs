// test/bridge-history.test.mjs -- "my transfers": payload decoding, sender-or-recipient lookup, and the public route.
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/bridge-history.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { NextRequest } from "next/server.js";
import { decodeTokenPayload, recordTransferInitiated, getTransfersForUser, getBridgeCollections, hashBridgeMessage } from "../src/lib/bridge.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const coder = ethers.AbiCoder.defaultAbiCoder();
const sender = ethers.Wallet.createRandom().address.toLowerCase();
const recipient = ethers.Wallet.createRandom().address.toLowerCase();
const stranger = ethers.Wallet.createRandom().address.toLowerCase();
const created = [];

function message({ msgType = 0, to = recipient, amount = ethers.parseUnits("5", 18), nonce = Date.now() + Math.floor(Math.random() * 1e6) } = {}) {
  const recipientBytes32 = ethers.zeroPadValue(to, 32);
  return {
    sourceChainId: "97", sourceContract: ethers.zeroPadValue("0x00000000000000000000000000000000000000aa", 32),
    destChainId: "296", destContract: ethers.zeroPadValue("0x00000000000000000000000000000000000000bb", 32),
    nonce: String(nonce), msgType, payload: coder.encode(["bytes32", "uint256"], [recipientBytes32, amount]),
  };
}

after(async () => {
  const { transfers } = await getBridgeCollections();
  await transfers.deleteMany({ _id: { $in: created } });
  await (await mongoClientPromise).close();
});

test("decodeTokenPayload reads recipient and amount from a token message and ignores other types", () => {
  const decoded = decodeTokenPayload(message({ amount: 5_000_000_000_000_000_000n }));
  assert.equal(decoded.recipientAddress, recipient);
  assert.equal(decoded.amount, "5000000000000000000");
  assert.equal(decodeTokenPayload(message({ msgType: 2 })), null, "a stake request is not a token mint");
  assert.equal(decodeTokenPayload(null), null);
  assert.equal(decodeTokenPayload({ msgType: 0, payload: "0x1234" }), null, "an undecodable payload is null, not a throw");
});

test("a non-EVM (e.g. Solana) recipient decodes the amount but yields no address", () => {
  const solanaLike = { ...message(), payload: coder.encode(["bytes32", "uint256"], ["0x" + "ab".repeat(32), 7n]) };
  const decoded = decodeTokenPayload(solanaLike);
  assert.equal(decoded.recipientAddress, null);
  assert.equal(decoded.amount, "7");
});

test("an indexer-backfilled transfer (no sender, amount 0) is found by its RECIPIENT with the real amount", async () => {
  const msg = message({ amount: 5_000_000_000_000_000_000n });
  const id = hashBridgeMessage(msg);
  created.push(id);
  await recordTransferInitiated({ messageHash: id, sourceChainId: 97, destChainId: 296, amount: "0", userAddress: ethers.ZeroAddress, sourceTxHash: "0xabc", kind: "backfill", message: msg }, { verified: true });

  const forRecipient = await getTransfersForUser(recipient);
  const doc = forRecipient.find((t) => t._id === id);
  assert.ok(doc, "the recipient can see a transfer addressed to them");
  assert.equal(doc.amount, "5000000000000000000");
  assert.equal(doc.recipientAddress, recipient);
  assert.equal((await getTransfersForUser(stranger)).some((t) => t._id === id), false, "an unrelated wallet does not see it");
});

test("a transfer registered by its sender is found by the sender AND the recipient", async () => {
  const msg = message({ amount: 2_000_000_000_000_000_000n });
  const id = hashBridgeMessage(msg);
  created.push(id);
  await recordTransferInitiated({ messageHash: id, sourceChainId: 97, destChainId: 296, amount: "2000000000000000000", userAddress: sender, sourceTxHash: "0xdef", message: msg });
  assert.ok((await getTransfersForUser(sender)).some((t) => t._id === id));
  assert.ok((await getTransfersForUser(recipient)).some((t) => t._id === id));
});

test("a client-supplied message that doesn't hash to its id is dropped, so it can't forge a recipient", async () => {
  const msg = message({ to: stranger });
  const forgedId = hashBridgeMessage(message()); // id of a DIFFERENT message
  created.push(forgedId);
  await recordTransferInitiated({ messageHash: forgedId, sourceChainId: 97, destChainId: 296, amount: "1000", userAddress: sender, sourceTxHash: "0x123", message: msg });
  const { transfers } = await getBridgeCollections();
  const doc = await transfers.findOne({ _id: forgedId });
  assert.equal(doc.message, null);
  assert.equal(doc.recipientAddress, null);
});

test("the public route returns sanitized transfers, newest first, and rejects a bad address", async () => {
  const { GET } = await import("../src/app/api/bridge/transfers/[address]/route.js");
  const req = (a) => new NextRequest(`http://localhost/api/bridge/transfers/${a}`, { headers: { "x-forwarded-for": "203.0.113.55" } });

  const bad = await GET(req("not-an-address"), { params: { address: "not-an-address" } });
  assert.equal(bad.status, 400);

  const res = await GET(req(recipient), { params: { address: recipient } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.transfers.length >= 2);
  const first = body.transfers[0];
  for (const key of ["messageHash", "status", "sourceChainId", "destChainId", "amount", "recipient"]) assert.ok(key in first, `${key} is returned`);
  assert.ok(!("message" in first) && !("sourceVerified" in first), "internal fields are not exposed");
  const dates = body.transfers.map((t) => new Date(t.createdAt).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
});
