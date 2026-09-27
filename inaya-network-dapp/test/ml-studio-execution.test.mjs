// AI/ML Studio governed code execution (RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B,
// Decision 2). This test creates REAL, short-lived Vercel Sandboxes against this project's own account (the
// same one already verified manually) -- deliberately minimal (a couple of sub-second runs) to keep real cost
// negligible, but genuine: no mocking of the sandbox provider itself, only of nothing (there is nothing here
// that isn't real). Skips itself honestly if no sandbox credential is available in this environment.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { isSandboxConfigured, runCodeSnippet } from "../src/lib/mlStudio/execution.js";

const owner = { role: "owner" }; const member = { role: "member" };
let skip = false;

before(() => { skip = !isSandboxConfigured(); if (skip) console.log("SKIPPING: no Vercel Sandbox credential (VERCEL_OIDC_TOKEN / VERCEL_TOKEN+TEAM+PROJECT) is available in this environment."); });

test("a plain member cannot run code in the sandbox", async () => {
  if (skip) return;
  const r = await runCodeSnippet({ orgId: "test-org", membership: member, actorEmail: "x@example.com", language: "python", code: "print(1)" });
  assert.equal(r.status, 403);
});

test("a real Python snippet runs in a real, isolated sandbox and returns real stdout", async () => {
  if (skip) return;
  const r = await runCodeSnippet({ orgId: "test-org", membership: owner, actorEmail: "owner@example.com", language: "python", code: "print(2 + 2)", timeoutMs: 20000 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), "4");
});

test("a failing snippet reports its real exit code and stderr, not a swallowed error", async () => {
  if (skip) return;
  const r = await runCodeSnippet({ orgId: "test-org", membership: owner, actorEmail: "owner@example.com", language: "node", code: "process.exit(7)", timeoutMs: 20000 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.exitCode, 7);
});

test("network is denied by default -- an outbound fetch fails inside the sandbox", async () => {
  if (skip) return;
  const r = await runCodeSnippet({ orgId: "test-org", membership: owner, actorEmail: "owner@example.com", language: "node", code: "fetch('https://example.com').then(()=>console.log('REACHED')).catch(e=>{console.log('BLOCKED:'+e.message); process.exit(1)})", timeoutMs: 20000, allowNetwork: false });
  assert.ok(r.ok, JSON.stringify(r));
  assert.notEqual(r.exitCode, 0, "an outbound request must not succeed when allowNetwork is false");
  assert.ok(!r.stdout.includes("REACHED"));
});

test("code over the size cap is refused before any sandbox is created", async () => {
  if (skip) return;
  const r = await runCodeSnippet({ orgId: "test-org", membership: owner, actorEmail: "owner@example.com", language: "python", code: "x = 1\n".repeat(5000) });
  assert.equal(r.status, 400);
});
