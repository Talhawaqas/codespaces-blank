// SQA-009 (S2): the faucet's lifetime cap holds under parallel requests (it used to be check-then-send-then-record).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { reserveInayaDrip, releaseInayaDrip, FAUCET_INAYA_LIFETIME_CAP, getFaucetCollections } from "../src/lib/faucet.js";
import clientPromise from "../src/lib/mongodb.js";

const wallets = [];
const fresh = () => { const w = ethers.Wallet.createRandom().address; wallets.push(w.toLowerCase()); return w; };
after(async () => {
  try { const { db } = await getFaucetCollections(); await db.collection("faucet_reservations").deleteMany({ _id: { $in: wallets } }); } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("parallel requests can never reserve more than the lifetime cap", async () => {
  const w = fresh();
  const results = await Promise.all(Array.from({ length: 25 }, () => reserveInayaDrip(w, 200)));
  const granted = results.filter(Boolean).length;
  assert.equal(granted, Math.floor(FAUCET_INAYA_LIFETIME_CAP / 200), "exactly cap/200 reservations fit; the rest are refused");
  const { db } = await getFaucetCollections();
  assert.ok((await db.collection("faucet_reservations").findOne({ _id: w.toLowerCase() })).reserved <= FAUCET_INAYA_LIFETIME_CAP);
});

test("a failed transfer gives the allowance back; a full wallet stays full", async () => {
  const w = fresh();
  assert.equal(await reserveInayaDrip(w, 500), true);
  assert.equal(await reserveInayaDrip(w, 1), false, "cap reached");
  await releaseInayaDrip(w, 500);
  assert.equal(await reserveInayaDrip(w, 500), true, "released allowance can be used again");
});
