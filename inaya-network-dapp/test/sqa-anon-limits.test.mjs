// SQA-012: anonymous write endpoints are rate limited per IP (feedback, learn reports). Invalid bodies are used so nothing is stored.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { POST as feedback } from "../src/app/api/feedback/submit/route.js";
import { POST as learnReport } from "../src/app/api/learn/report/route.js";
import clientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const ip = `sqa-${randomBytes(4).toString("hex")}`;
after(async () => {
  try { const { db } = await connectToDatabase(); await db.collection("rate_limit_hits").deleteMany({ key: ip }); } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});
const req = () => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({}) });

test("feedback: the 11th request from one address in an hour is refused", async () => {
  const codes = []; for (let i = 0; i < 11; i++) codes.push((await feedback(req())).status);
  assert.ok(codes.slice(0, 10).every((c) => c === 400), `first ten reach validation: ${codes}`);
  assert.equal(codes[10], 429);
});
test("learn report: the 21st request from one address in an hour is refused", async () => {
  const codes = []; for (let i = 0; i < 21; i++) codes.push((await learnReport(req())).status);
  assert.ok(codes.slice(0, 20).every((c) => c === 400), `first twenty reach validation: ${codes}`);
  assert.equal(codes[20], 429);
});

import { POST as feedbackUpload } from "../src/app/api/feedback/upload/route.js";

test("feedback upload: malformed (non-multipart) input is a 400, not a 500; the 11th call from one address is refused", async () => {
  const codes = []; for (let i = 0; i < 11; i++) codes.push((await feedbackUpload(req())).status);
  assert.ok(codes.slice(0, 10).every((c) => c === 400), `first ten are validation failures, not server errors: ${codes}`);
  assert.equal(codes[10], 429);
});
