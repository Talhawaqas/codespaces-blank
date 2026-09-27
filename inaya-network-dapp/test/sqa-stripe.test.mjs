// SQA-007 (S1): on-chain Stripe settlements run at most once per session, resume after a failure, and ignore unpaid sessions.
// The webhook is driven with genuinely signed events; nothing here reaches a blockchain or Stripe's API.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { claimSettlement, completeSettlement, failSettlement, getProgress, recordProgress } from "../src/lib/stripeSettlement.js";
import clientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_sqa";
const WEBHOOK_SECRET = "whsec_sqa_test_secret"; process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
const { POST: webhook } = await import("../src/app/api/stripe-webhook/route.js");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const ids = [];
const sid = () => { const id = `cs_test_sqa_${randomBytes(6).toString("hex")}`; ids.push(id); return id; };
after(async () => {
  try { const { db } = await connectToDatabase(); await db.collection("stripe_settlements").deleteMany({ _id: { $in: ids } }); } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

const signed = (event, secret = WEBHOOK_SECRET) => {
  const payload = JSON.stringify(event);
  return new Request("http://localhost/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret }) }, body: payload });
};
const completed = (id, extra = {}) => ({ id: `evt_${id}`, object: "event", type: "checkout.session.completed", data: { object: { id, object: "checkout.session", payment_status: "paid", amount_total: 450000, customer_details: { email: "buyer@example.com" }, metadata: { checkoutType: "corporate_reserve", tier: "GOLD" }, ...extra } } });

test("only one of many concurrent deliveries claims a settlement; a repeat after completion is a no-op", async () => {
  const id = sid();
  const claims = await Promise.all(Array.from({ length: 12 }, () => claimSettlement(id, "corporate_reserve")));
  assert.equal(claims.filter((c) => c.claimed).length, 1, "exactly one delivery may settle");
  assert.ok(claims.filter((c) => !c.claimed).every((c) => c.status === "processing"));
  await completeSettlement(id, { routerTxHash: "0xaa" });
  const again = await claimSettlement(id, "corporate_reserve");
  assert.equal(again.claimed, false); assert.equal(again.status, "completed"); assert.equal(again.result.routerTxHash, "0xaa");
});

test("a failed settlement is released for exactly one retry and resumes from the on-chain step it reached", async () => {
  const id = sid();
  assert.equal((await claimSettlement(id, "corporate_reserve")).claimed, true);
  await recordProgress(id, { routerTxHash: "0xrouter" });
  await failSettlement(id, new Error("escrow tx reverted"));
  const retries = await Promise.all([claimSettlement(id, "corporate_reserve"), claimSettlement(id, "corporate_reserve"), claimSettlement(id, "corporate_reserve")]);
  assert.equal(retries.filter((r) => r.claimed).length, 1, "one retry only");
  assert.equal((await getProgress(id)).routerTxHash, "0xrouter", "the router step is remembered, so it is not paid for twice");
});

test("webhook: bad signature 400; unpaid session ignored; duplicate delivery does not settle again; in-progress delivery is not re-run", async () => {
  assert.equal((await webhook(signed(completed(sid()), "whsec_wrong"))).status, 400);

  const unpaid = await webhook(signed(completed(sid(), { payment_status: "unpaid" })));
  assert.equal((await unpaid.json()).ignored, "payment not completed");

  const done = sid(); await claimSettlement(done, "corporate_reserve"); await completeSettlement(done, { routerTxHash: "0x1", escrowTxHash: "0x2" });
  const dup = await webhook(signed(completed(done)));
  const dupBody = await dup.json();
  assert.equal(dup.status, 200); assert.equal(dupBody.duplicate, true); assert.equal(dupBody.routerTxHash, "0x1", "Stripe gets a success and the settlement is not repeated");

  const busy = sid(); await claimSettlement(busy, "payg_upload");
  const r = await webhook(signed(completed(busy, { metadata: { checkoutType: "payg_upload" } })));
  assert.equal(r.status, 409, "an attempt that is (or died) mid-settlement is never silently re-run on-chain");
});
