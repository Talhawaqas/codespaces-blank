// SQA-013 regression test: the public node listing never includes an operator's private telemetry.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GET as nodesList } from "../src/app/api/nodes/list/route.js";
import clientPromise from "../src/lib/mongodb.js";

after(async () => { try { await (await clientPromise).close(); } catch { /* ignore */ } });

test("nodes list: the public listing never includes an operator's private telemetry", async () => {
  const db = (await clientPromise).db("inaya_network"); const nodeId = `sqa-node-${randomBytes(4).toString("hex")}`;
  await db.collection("nodes").insertOne({ nodeId, operatorWallet: "0x00000000000000000000000000000000000000aa", tier: "Entry", totalCapacityGB: 10, usedCapacityGB: 1, registeredAt: new Date(),
    heartbeatLog: ["2026-01-01"], lastErrorMessage: "ENOSPC at /srv/secret/path", restartCount: 7, daemonVersion: "0.1.0", endpoint: "http://10.0.0.5:9000", internalNote: "private" });
  try {
    const body = await (await nodesList()).json(); const mine = body.nodes.find((n) => n.nodeId === nodeId);
    assert.ok(mine, "the node is listed"); assert.equal(mine.tier, "Entry");
    for (const k of ["heartbeatLog", "lastErrorMessage", "restartCount", "daemonVersion", "endpoint", "internalNote", "_id"]) assert.equal(k in mine, false, `${k} must not be public`);
  } finally { await db.collection("nodes").deleteMany({ nodeId }); }
});
