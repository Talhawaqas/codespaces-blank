// test/workspace-ideas.test.mjs -- "Suggest an improvement" (post-SOW #6): privacy between companies, one vote per person,
// public board only after Inaya approves, and notifications to submitter + voters on Planned / Shipped.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import mongoClientPromise from "../src/lib/mongodb.js";
import { getFeedbackCollections } from "../src/lib/feedback.js";
import { submitIdea, listIdeas, voteIdea, notifyIdeaStatus } from "../src/lib/workspaceIdeas.js";
import { connectToDatabase } from "../src/lib/mongodb.js";
const getNotificationCollections = async () => ({ notifications: (await connectToDatabase()).db.collection("notifications") });

const A = String(new ObjectId()), Bo = String(new ObjectId()); const run = Date.now().toString(36);
const a1 = `a1-${run}@ideas.example`, b1 = `b1-${run}@ideas.example`;
after(async () => {
  const { feedback } = await getFeedbackCollections(); await feedback.deleteMany({ orgId: { $in: [A, Bo] } });
  const { notifications } = await getNotificationCollections(); await notifications.deleteMany({ orgId: { $in: [A, Bo, new ObjectId(A), new ObjectId(Bo)] } });
  await (await mongoClientPromise).close();
});

test("ideas: private to the company until on the public board; one vote per person; notifications on Planned/Shipped", { timeout: 60000 }, async () => {
  assert.equal((await submitIdea({ orgId: A, orgName: "Alpha", email: a1, input: { title: "x", problem: "too short" } })).status, 400);
  const s = await submitIdea({ orgId: A, orgName: "Alpha", email: a1, input: { title: "Barcode labels from the product list", problem: "We print labels by hand in Word; our supplier names are confidential.", importance: "Critical for us" } });
  assert.ok(s.idea?.id, s.error); assert.equal(s.idea.votes, 1); assert.equal(s.idea.votedByMe, true);
  // company A sees it in full; company B sees nothing yet (not on the board)
  const la = await listIdeas({ orgId: A, email: a1 }); assert.equal(la.mine[0].problem.includes("confidential"), true);
  const lb = await listIdeas({ orgId: Bo, email: b1 }); assert.equal(lb.mine.length, 0); assert.equal(lb.board.some((i) => i.id === s.idea.id), false);
  assert.equal((await voteIdea({ orgId: Bo, email: b1, id: s.idea.id })).status, 404, "B can't vote on an idea it can't see");
  // Inaya puts it on the board: B sees the TITLE only and can +1 once
  const { feedback } = await getFeedbackCollections(); await feedback.updateOne({ _id: new ObjectId(s.idea.id) }, { $set: { status: "Reviewing" } });
  const lb2 = await listIdeas({ orgId: Bo, email: b1 }); const seen = lb2.board.find((i) => i.id === s.idea.id);
  assert.ok(seen); assert.equal(seen.problem, undefined, "other companies never see the description"); assert.equal(seen.mine, false);
  assert.equal((await voteIdea({ orgId: Bo, email: b1, id: s.idea.id })).idea.votes, 2);
  assert.equal((await voteIdea({ orgId: Bo, email: b1, id: s.idea.id })).idea.votes, 2, "a second +1 by the same person does nothing");
  assert.equal((await voteIdea({ orgId: Bo, email: b1, id: s.idea.id, on: false })).idea.votes, 1);
  await voteIdea({ orgId: Bo, email: b1, id: s.idea.id });
  // Planned in a sprint -> submitter and voter are notified, once each
  const planned = await feedback.findOneAndUpdate({ _id: new ObjectId(s.idea.id) }, { $set: { status: "Planned", sprint: "Sprint 3" } }, { returnDocument: "after" });
  assert.equal(await notifyIdeaStatus(planned), 2);
  assert.equal(await notifyIdeaStatus(planned), 2, "repeat calls upsert, never duplicate (dedupe key)");
  const { notifications } = await getNotificationCollections();
  const n = await notifications.find({ sourceModule: "ideas", sourceId: s.idea.id }).toArray();
  assert.equal(n.length, 2); assert.ok(n.every((x) => /Planned/.test(x.title)));
  assert.equal((await listIdeas({ orgId: A, email: a1 })).mine[0].sprint, "Sprint 3");
});
