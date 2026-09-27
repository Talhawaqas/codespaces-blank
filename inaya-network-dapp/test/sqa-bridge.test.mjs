// SQA-005 (S0) / SQA-006 (S3) regression tests: the bridge relayer must never sign a message the source chain did not emit, and the
// public registration routes must not be able to overwrite or forge transfer records.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { hashBridgeMessage, verifyMessageOnSource } from "../src/lib/bridgeMessage.js";
import { recordTransferInitiated, getBridgeCollections, markTransferStatus } from "../src/lib/bridge.js";
import { POST as initiate } from "../src/app/api/bridge/initiate-transfer/route.js";
import { GET as relay } from "../src/app/api/bridge/cron/relay-messages/route.js";
import clientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const ids = [];
after(async () => {
  try {
    const { transfers, validatorSigs } = await getBridgeCollections();
    await transfers.deleteMany({ _id: { $in: ids } }); await validatorSigs.deleteMany({ messageHash: { $in: ids } });
    const { db } = await connectToDatabase(); await db.collection("rate_limit_hits").deleteMany({ action: "bridge:register", key: "sqa-test-ip" });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

const rnd = () => ethers.hexlify(ethers.randomBytes(32));
const coder = ethers.AbiCoder.defaultAbiCoder();
const attackerMessage = () => ({ sourceChainId: "999999", sourceContract: ethers.zeroPadValue("0x00000000000000000000000000000000000000aa", 32), destChainId: "97", destContract: ethers.zeroPadValue("0x00000000000000000000000000000000000000bb", 32), nonce: "1", msgType: 0, payload: coder.encode(["address", "uint256"], ["0x00000000000000000000000000000000000000cc", 10n ** 24n]) });
const post = (body) => new Request("http://localhost/api/bridge/initiate-transfer", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "sqa-test-ip" }, body: JSON.stringify(body) });

test("a client cannot overwrite, re-open or re-message an existing transfer (previously an upsert let anyone do all three)", async () => {
  const msg = attackerMessage(); const id = hashBridgeMessage(msg); ids.push(id);
  await recordTransferInitiated({ messageHash: id, sourceChainId: 999999, destChainId: 97, amount: "5", userAddress: "0x00000000000000000000000000000000000000cc", sourceTxHash: rnd(), message: msg });
  const { transfers } = await getBridgeCollections();
  await markTransferStatus(id, "completed", { destTxHash: "0xdone" });
  const evil = { ...msg, payload: coder.encode(["address", "uint256"], ["0x00000000000000000000000000000000000000dd", 10n ** 30n]) };
  const res = await initiate(post({ messageHash: id, sourceChainId: 999999, destChainId: 97, amount: "999999999", userAddress: "0x00000000000000000000000000000000000000dd", sourceTxHash: rnd(), message: evil }));
  assert.equal(res.status, 200);
  const doc = await transfers.findOne({ _id: id });
  assert.equal(doc.status, "completed", "a completed transfer is not reset to pending");
  assert.equal(doc.amount, "5"); assert.equal(doc.userAddress, "0x00000000000000000000000000000000000000cc"); assert.equal(doc.message.payload, msg.payload, "message untouched");
  assert.equal(doc.sourceVerified, false, "client data is never marked verified");
});

test("a message that does not hash to its id is not stored at all; malformed ids are refused", async () => {
  const id = rnd(); ids.push(id);
  await recordTransferInitiated({ messageHash: id, sourceChainId: 999999, destChainId: 97, amount: "1", userAddress: "0x00000000000000000000000000000000000000cc", sourceTxHash: rnd(), message: attackerMessage() });
  const { transfers } = await getBridgeCollections();
  assert.equal((await transfers.findOne({ _id: id })).message, null);
  assert.equal((await initiate(post({ messageHash: "not-a-hash", sourceChainId: 999999, destChainId: 97, amount: "1", userAddress: "0x00000000000000000000000000000000000000cc" }))).status, 400);
});

test("verified (source-chain) data attaches the chain's message but never lowers a status or rewrites amount/user", async () => {
  const msg = attackerMessage(); msg.nonce = "2"; const id = hashBridgeMessage(msg); ids.push(id);
  await recordTransferInitiated({ messageHash: id, sourceChainId: 999999, destChainId: 97, amount: "77", userAddress: "0x00000000000000000000000000000000000000cc", sourceTxHash: rnd(), message: null });
  await markTransferStatus(id, "validating");
  await recordTransferInitiated({ messageHash: id, sourceChainId: 999999, destChainId: 97, amount: "0", userAddress: ethers.ZeroAddress, sourceTxHash: rnd(), kind: "backfill", message: msg }, { verified: true });
  const { transfers } = await getBridgeCollections(); const d = await transfers.findOne({ _id: id });
  assert.equal(d.sourceVerified, true); assert.equal(d.message.nonce, "2");
  assert.equal(d.status, "validating"); assert.equal(d.amount, "77", "the indexer no longer overwrites the amount the dApp recorded with 0");
  assert.equal(d.userAddress, "0x00000000000000000000000000000000000000cc");
});

test("verifyMessageOnSource accepts only a real MessageSent from the trusted messenger that matches the id", async () => {
  const iface = new ethers.Interface(["event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)"]);
  const messenger = "0x00000000000000000000000000000000000000ee"; const msg = attackerMessage(); const id = hashBridgeMessage(msg);
  const enc = (messageId, m, address = messenger) => { const l = iface.encodeEventLog("MessageSent", [messageId, [m.sourceChainId, m.sourceContract, m.destChainId, m.destContract, m.nonce, m.msgType, m.payload]]); return { address, topics: l.topics, data: l.data }; };
  const prov = (receipt) => ({ getTransactionReceipt: async () => receipt });
  const ok = await verifyMessageOnSource({ messageHash: id, sourceTxHash: rnd(), provider: prov({ status: 1, logs: [enc(id, msg)] }), messengerAddress: messenger });
  assert.equal(ok.ok, true); assert.equal(hashBridgeMessage(ok.message), id);
  const bad = async (receipt, why) => assert.equal((await verifyMessageOnSource({ messageHash: id, sourceTxHash: rnd(), provider: prov(receipt), messengerAddress: messenger })).ok, false, why);
  await bad(null, "unknown transaction");
  await bad({ status: 0, logs: [enc(id, msg)] }, "failed source transaction");
  await bad({ status: 1, logs: [enc(id, msg, "0x00000000000000000000000000000000000000ff")] }, "an event from a different contract is not the messenger's");
  await bad({ status: 1, logs: [enc(rnd(), msg)] }, "a different message id");
  await bad({ status: 1, logs: [enc(id, { ...msg, nonce: "9" })] }, "an event whose message does not hash to its own id");
  await bad({ status: 1, logs: [] }, "no event at all");
  assert.equal((await verifyMessageOnSource({ messageHash: id, sourceTxHash: rnd(), provider: null, messengerAddress: messenger })).ok, false, "no provider means no trust");
});

test("the relay cron never has validators sign a forged, client-registered message", async (t) => {
  // the cron scans every pending transfer, so never run it (with throwaway keys) against a database that holds real ones
  const pre = await getBridgeCollections();
  if (await pre.transfers.countDocuments({ status: { $in: ["pending", "validating"] }, message: { $ne: null }, _id: { $nin: ids } }) > 0) return t.skip("real pending bridge transfers exist in this database");
  process.env.CRON_SECRET = "sqa-cron"; process.env.RELAYER_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey; process.env.BRIDGE_VALIDATOR_PRIVATE_KEY_1 = ethers.Wallet.createRandom().privateKey; process.env.BRIDGE_VALIDATOR_THRESHOLD = "1";
  const msg = attackerMessage(); msg.nonce = "3"; const id = hashBridgeMessage(msg); ids.push(id);
  // the attack: a perfectly well-formed forged message registered through the public route, source chain 999999 has no messenger
  const reg = await initiate(post({ messageHash: id, sourceChainId: 999999, destChainId: 97, amount: "1", userAddress: "0x00000000000000000000000000000000000000cc", sourceTxHash: rnd(), message: msg }));
  assert.equal(reg.status, 200);
  const res = await relay(new Request("http://localhost/api/bridge/cron/relay-messages", { headers: { authorization: "Bearer sqa-cron" } }));
  const body = await res.json(); const mine = body.results.find((r) => r.messageHash === id);
  assert.equal(mine.status, "unverified_source", JSON.stringify(mine));
  const { validatorSigs, transfers } = await getBridgeCollections();
  assert.equal(await validatorSigs.countDocuments({ messageHash: id }), 0, "no validator signature was produced for the forged message");
  assert.equal((await transfers.findOne({ _id: id })).sourceVerified, false);
  assert.equal((await relay(new Request("http://localhost/x", { headers: { authorization: "Bearer wrong" } }))).status, 401);
});
