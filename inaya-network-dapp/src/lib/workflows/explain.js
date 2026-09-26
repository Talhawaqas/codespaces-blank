// src/lib/workflows/explain.js
//
// SOW §23, §68: "Why did this workflow do this?" The answer is assembled
// deterministically from what the engine recorded (node results and the verified
// evidence rows), never from asking a model to justify itself, and it never
// includes hidden reasoning. It answers: what triggered it, what data was read,
// which rules and thresholds applied, which tools were called, what the AI
// concluded (structured), which branch was taken and why, what was approved, what
// action happened, what was sent, and which evidence proves it.

import { getExecution } from "./service.js";
import { listWorkflowEvidence, verifyWorkflowEvidence } from "./evidence.js";
import { fail } from "./common.js";

export async function explainExecution({ orgId, executionId, membership, email }) {
  const got = await getExecution({ orgId, executionId, membership, email });
  if (got.error) return got;
  const e = got.execution;
  const nr = e.nodeResults || {};
  const evidence = await listWorkflowEvidence({ orgId, executionId });
  const verification = await verifyWorkflowEvidence({ orgId, executionId });
  const entries = Object.entries(nr);

  const dataSources = entries.filter(([, r]) => r.type?.startsWith("data.") || r.type === "http.request").map(([k, r]) => ({ node: k, source: r.dataSource, status: r.status, summary: r.outputSummary, permissionContext: r.permissionContext, synthetic: !!r.synthetic }));
  const conditions = entries.filter(([, r]) => r.type === "condition.if" && r.status === "COMPLETED").map(([k, r]) => ({
    node: k, expression: r.output?.expression, rules: r.output?.rules, result: r.output?.result, branch: r.output?.branch,
    because: r.output?.result ? `The condition "${r.output?.expression || "rules"}" was TRUE, so the "yes" path ran.` : `The condition "${r.output?.expression || "rules"}" was FALSE, so the "no" path ran.`,
  }));
  const ai = entries.find(([, r]) => r.type === "ai.agent" && r.status === "COMPLETED");
  const aiOut = ai?.[1]?.output;
  const approvals = entries.filter(([, r]) => r.type === "action.propose").map(([k, r]) => ({ node: k, tool: r.output?.tool, requestId: r.output?.requestId || null, requested: !!r.output?.submitted, simulated: !!r.output?.simulated, approvalStatus: r.output?.approvalStatus || r.output?.status || null, reviewedBy: r.output?.reviewedBy || null, executedAt: r.output?.executedAt || null }));
  const notifications = entries.filter(([, r]) => r.type?.startsWith("notify.") && r.status === "COMPLETED").map(([k, r]) => ({ node: k, channel: r.output?.channel, delivered: r.output?.delivered, simulated: !!r.output?.simulated, deliveries: r.output?.deliveries, wouldSend: r.output?.wouldSend || undefined }));
  const skipped = entries.filter(([, r]) => r.status === "SKIPPED").map(([k, r]) => ({ node: k, reason: r.skippedReason }));

  const lines = [];
  lines.push(`Triggered by: ${e.trigger?.type}${e.trigger?.scheduledFor ? ` (scheduled for ${e.trigger.scheduledFor})` : ""}, running as ${e.runAs} (${e.mode}).`);
  if (dataSources.length) lines.push(`Data read: ${dataSources.map((d) => d.node).join(", ")}.`);
  if (aiOut?.deterministic?.thresholds?.length) lines.push(`Thresholds: ${aiOut.deterministic.thresholds.map((t) => `${t.name} = ${t.value} ${t.op} ${t.threshold}${t.exceeded ? " (exceeded)" : ""}`).join("; ")}.`);
  if (aiOut?.result) lines.push(`AI conclusion (structured): ${aiOut.result.classification}${aiOut.result.urgent ? ", urgent" : ""}, confidence ${aiOut.result.confidence}.`);
  for (const c of conditions) lines.push(c.because);
  for (const a of approvals) lines.push(a.simulated ? `Approval step ${a.node} was simulated (${e.mode}).` : `Approval requested for ${a.tool}: ${a.approvalStatus || "pending"}${a.reviewedBy ? ` by ${a.reviewedBy}` : ""}.`);
  for (const n of notifications) lines.push(n.simulated ? `Notification ${n.node} would have been sent (${e.mode}).` : `Notification ${n.node} via ${n.channel}: ${n.delivered} delivered.`);
  if (e.status !== "COMPLETED") lines.push(`Final status: ${e.status}${e.failedNode ? ` (failed node: ${e.failedNode})` : ""}.`);

  return {
    explanation: {
      executionId: e.executionId, workflow: { id: e.workflowId, name: e.workflowName, version: e.workflowVersion }, status: e.status, mode: e.mode,
      triggeringEvent: e.trigger, identity: { initiatedBy: e.initiatingIdentity, runAs: e.runAs },
      dataSources, rulesAndThresholds: { conditions, thresholds: aiOut?.deterministic?.thresholds || [] },
      toolCalls: aiOut?.explainability?.toolCalls || [], aiConclusion: aiOut?.result || null, aiInputs: aiOut?.explainability?.inputSources || [],
      securityFindings: aiOut?.explainability?.securityFindings || null, approvals, notifications, skipped,
      narrative: lines,
      evidence: { rows: evidence.map((r) => ({ evidenceId: String(r._id), action: r.action, node: r.nodeKey, at: r.createdAt, rowHash: r.rowHash })), verified: verification.verified, problems: verification.problems },
      notice: "Hidden model reasoning is not recorded and cannot be shown; this explanation comes from recorded inputs, rules, tool calls and the AI's structured answer.",
    },
  };
}

export { fail };
