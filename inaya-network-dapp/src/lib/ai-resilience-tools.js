// src/lib/ai-resilience-tools.js
//
// Autonomous Resilience Layer SOW, Phase 8 — permission-aware AI over
// resilience policies/test results, same buildXContext/X_TOOL_
// DECLARATIONS/runXTool/xSystemInstruction shape as every other vertical
// file (ai-government-tools.js, ai-audit-tools.js, etc.), wired into
// ai-os-router.js with prefix "resilience_".
//
// READ-ONLY BY DEFAULT, STRUCTURALLY: get_resilience_status/
// get_last_test_result/list_failed_assets/explain_test_failure declare no
// mutation path at all — matching ai-audit-tools.js's "zero mutation
// tools, enforced by what's declared, never by a prompt instruction"
// discipline. This satisfies the SOW's explicit "AI must not declare
// compliance/certification, fabricate results, or alter policy without
// authorization" requirement structurally: there is no tool here that
// could do any of those things, regardless of what the model is asked.
//
// trigger_resilience_test_now is the one exception, and it is NOT routed
// through Guarded Execution (unlike every propose_* tool in
// ai-business-tools.js) -- deliberately, because it can only ever start
// the exact same non-destructive synthetic-canary test the daily cron
// already runs unattended. The SOW's controlled-action requirement is
// about workflows that could touch REAL recovery/production data; this
// SOW has none (Non-Goals explicitly exclude destructive production
// recovery testing), so there is nothing here for Guarded Execution to
// gate. Still canManageOrg-gated, same as creating a policy.

import { Type } from "@google/genai";
import { canManageOrg } from "./orgs.js";
import { getResilienceStatus } from "./resilience-status.js";
import { getLatestTestRun, runResilienceTest } from "./resilience-orchestrator.js";

export async function buildResilienceContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

async function getResilienceStatusTool(_args, ctx) {
  return getResilienceStatus(ctx.orgId);
}

async function getLastTestResultTool(args, ctx) {
  const { policyName } = args || {};
  const { policies } = await getResilienceStatus(ctx.orgId);
  const matches = policyName ? policies.filter((p) => p.name.toLowerCase().includes(policyName.toLowerCase())) : policies;
  if (matches.length === 0) return { notFound: true, policyName: policyName || null };
  if (matches.length > 1 && policyName) return { ambiguous: true, matches: matches.map((p) => p.name) };

  const results = [];
  for (const p of matches) {
    const { testRun } = await getLatestTestRun({ orgId: ctx.orgId, policyId: p.policyId });
    results.push({ policyName: p.name, resilienceState: p.resilienceState, latestTestRun: testRun });
  }
  return { results };
}

async function listFailedAssetsTool(args, ctx) {
  const { policyName } = args || {};
  const { policies } = await getResilienceStatus(ctx.orgId);
  const matches = policyName ? policies.filter((p) => p.name.toLowerCase().includes(policyName.toLowerCase())) : policies;

  const failedAssets = [];
  for (const p of matches) {
    if (!p.latestTestRun) continue;
    for (const asset of p.latestTestRun.assetResults) {
      const failed = !asset.recovered || !asset.integrityPass || !asset.permissionPass || !asset.dependencyOk;
      if (failed) {
        failedAssets.push({
          policyName: p.name, categoryLabel: asset.categoryLabel,
          recovered: asset.recovered, integrityPass: asset.integrityPass, permissionPass: asset.permissionPass, dependencyOk: asset.dependencyOk,
          error: asset.error || null,
        });
      }
    }
  }
  return { count: failedAssets.length, failedAssets };
}

async function explainTestFailureTool(args, ctx) {
  const { policyName } = args || {};
  const { results } = await getLastTestResultTool({ policyName }, ctx);
  if (!results || results.length === 0) return { notFound: true };
  const withRun = results.find((r) => r.latestTestRun);
  if (!withRun) return { notFound: true, message: "No test has run yet for this policy." };
  const run = withRun.latestTestRun;
  if (run.overallResult === "PASS") return { wasFailure: false, message: `The latest test for "${withRun.policyName}" PASSED — nothing to explain.` };

  const reasons = [];
  if (run.rtoPass === false) reasons.push(`Actual recovery time (${run.actualRTOMinutes.toFixed(1)}m) exceeded the required RTO.`);
  if (run.rpoPass === false) reasons.push(`Actual recovery point (${run.actualRPOMinutes.toFixed(1)}m) exceeded the required RPO.`);
  for (const asset of run.assetResults) {
    if (!asset.recovered) reasons.push(`"${asset.categoryLabel}" failed to recover${asset.error ? `: ${asset.error}` : "."}`);
    else if (!asset.integrityPass) reasons.push(`"${asset.categoryLabel}" recovered but failed integrity verification (content did not match the expected hash).`);
    else if (!asset.permissionPass) reasons.push(`"${asset.categoryLabel}" recovered but its permission boundary was not correctly restored.`);
    else if (!asset.dependencyOk) reasons.push(`"${asset.categoryLabel}" has an unreachable backup replica dependency.`);
  }
  return { wasFailure: true, policyName: withRun.policyName, testRunCompletedAt: run.completedAt, reasons };
}

async function triggerResilienceTestNowTool(args, ctx) {
  const { policyName } = args || {};
  if (!canManageOrg(ctx.membership)) return { error: "Only the owner or an admin can trigger a resilience test." };
  const { policies } = await getResilienceStatus(ctx.orgId);
  const matches = policies.filter((p) => p.name.toLowerCase().includes((policyName || "").toLowerCase()));
  if (matches.length === 0) return { notFound: true, policyName };
  if (matches.length > 1) return { ambiguous: true, matches: matches.map((p) => p.name) };

  const result = await runResilienceTest({ orgId: ctx.orgId, policyId: matches[0].policyId, membership: ctx.membership, actorEmail: ctx.email, triggeredBy: "manual" });
  if (result.error) return { error: result.error };
  return {
    started: true, policyName: matches[0].name, overallResult: result.testRun.overallResult,
    message: `Ran the same non-destructive canary test the daily schedule already runs — result: ${result.testRun.overallResult}.`,
  };
}

export const RESILIENCE_TOOL_DECLARATIONS = [
  {
    name: "get_resilience_status",
    description: "Get every resilience policy's current state (VERIFIED/DEGRADED/FAILED/UNKNOWN/TEST_DUE), always computed from real test data, never asserted. Use for \"are we resilient\", \"can we recover X\", or a general resilience overview.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_last_test_result",
    description: "Get the most recent completed resilience test's real RTO/RPO measurements and pass/fail result, optionally for one named policy. Use for \"when was our last successful recovery test\" or \"what was our actual recovery time\".",
    parameters: { type: Type.OBJECT, properties: { policyName: { type: Type.STRING, description: "Filter to a policy whose name contains this text." } } },
  },
  {
    name: "list_failed_assets",
    description: "List every critical asset category that failed its latest resilience test (recovery, integrity, dependency, or permission failure), optionally for one named policy.",
    parameters: { type: Type.OBJECT, properties: { policyName: { type: Type.STRING, description: "Filter to a policy whose name contains this text." } } },
  },
  {
    name: "explain_test_failure",
    description: "Explain, in plain terms grounded ONLY in the actual test-run record, why the latest resilience test for a policy failed (which requirement or asset, and why). Never speculate beyond what the test-run record actually says.",
    parameters: { type: Type.OBJECT, properties: { policyName: { type: Type.STRING, description: "The policy to explain, or a distinctive part of its name." } }, required: ["policyName"] },
  },
  {
    name: "trigger_resilience_test_now",
    description: "Run a resilience test immediately for a named policy, instead of waiting for its scheduled window. This only ever runs the same non-destructive synthetic-canary test the daily schedule already runs unattended — it never touches real production data and never requires approval.",
    parameters: { type: Type.OBJECT, properties: { policyName: { type: Type.STRING, description: "The policy to test, or a distinctive part of its name." } }, required: ["policyName"] },
  },
];

const TOOL_IMPLEMENTATIONS = {
  get_resilience_status: getResilienceStatusTool,
  get_last_test_result: getLastTestResultTool,
  list_failed_assets: listFailedAssetsTool,
  explain_test_failure: explainTestFailureTool,
  trigger_resilience_test_now: triggerResilienceTestNowTool,
};

export async function runResilienceTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function resilienceSystemInstruction() {
  return `For questions about recovery capability, resilience status, or past test results, use the resilience_ tools -- ground every answer only in what they return. Never declare compliance or certification, never claim a recovery capability that hasn't been verified by an actual test (a policy with resilienceState "UNKNOWN" means no test has run yet, not that recovery would work), and never fabricate a test result. If asked to explain a failure, use resilience_explain_test_failure and relay only what the real test-run record says. resilience_trigger_resilience_test_now is safe to call directly when asked to "run/test resilience now" -- it only ever runs the same non-destructive test the daily schedule already runs, never a real production recovery.`;
}
