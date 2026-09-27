// src/lib/mlStudio/execution.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B, §"notebook environment (explicitly
// conditional on safe sandboxing existing)" and §10.9's isolated-session / execution-timeout / resource-limit
// requirements. The capability audit's Decision 2 was: build the governance-only slice UNLESS a real
// sandboxed compute provider exists -- Vercel Sandbox is real, already verified end-to-end against this
// deployment's own account (isolated Firecracker microVMs, per-run, billed by active CPU time), so this is
// the one honest slice of "notebook" this pass delivers: run ONE governed code snippet, capture its result,
// and stop the sandbox. It is explicitly NOT a persistent notebook (no saved kernel state between calls, no
// cell-to-cell variable sharing) -- that would need a persistent sandbox and a session-management layer this
// pass does not build; calling it a "notebook" here would be exactly the "unsafe pseudo-notebook" the SOW
// says never to ship. What this narrows down to, honestly: a governed, audited, single-shot code runner.
//
// Safety posture, each one deliberate:
//   - owner/admin only (real, billable external compute -- same bar as provisioning a database instance)
//   - rate-limited per user (this spends real money on Vercel's Active CPU pricing)
//   - network denied by default (networkPolicy: "deny-all") -- code cannot exfiltrate or fetch by default
//   - Inaya's own server environment is NEVER passed into the sandbox (env: {} unless the caller explicitly
//     allow-lists specific names) -- a real secret leaking into agent-run code is the one failure mode this
//     module refuses to allow by default
//   - every run is audited (who, what language, a hash of the code, exit code, duration) and Evidence-Graph
//     linked to a model/catalog subject when the caller says which one it was for

import { checkRateLimit } from "../rateLimit.js";
import { canManageOrg } from "../orgs.js";
import { fail, sha256 } from "../docIntelligence/common.js";
import { event, link, notify } from "./record.js";

const MAX_CODE_CHARS = 20000;
const MAX_OUTPUT_CHARS = 20000;
const MAX_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes -- well under Vercel's own 45-minute ceiling, deliberately conservative for a first pass
const LANGUAGES = {
  python: { cmd: "python3", args: (code) => ["-c", code] },
  node: { cmd: "node", args: (code) => ["-e", code] },
};

const truncate = (s) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : s);

export function isSandboxConfigured() {
  // Real Vercel OIDC (automatic once this app runs ON Vercel, or a locally pulled dev token) or an explicit
  // access-token triple for non-Vercel hosting -- either is a real, working credential path, never assumed.
  return !!(process.env.VERCEL_OIDC_TOKEN || (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID));
}

/**
 * Runs one code snippet in a fresh, isolated Vercel Sandbox and stops it immediately after. Returns
 * { ok, exitCode, stdout, stderr, durationMs } or a { error, status } pair.
 */
export async function runCodeSnippet({ orgId, membership, actorEmail, language, code, relatedModelId = null, allowNetwork = false, timeoutMs = 30000 }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can run code in a sandbox.", 403);
  if (!isSandboxConfigured()) return fail("No sandbox compute provider is configured on this server.", 400);
  if (!LANGUAGES[language]) return fail(`language must be one of ${Object.keys(LANGUAGES).join(", ")}.`, 400);
  const src = String(code || "");
  if (!src.trim()) return fail("code is required.", 400);
  if (src.length > MAX_CODE_CHARS) return fail(`code can be at most ${MAX_CODE_CHARS} characters.`, 400);
  const budget = Math.min(Number(timeoutMs) || 30000, MAX_TIMEOUT_MS);

  try { await checkRateLimit({ action: "ml-studio:execute", key: actorEmail, max: 20, windowMs: 60 * 60 * 1000 }); }
  catch { return fail("Too many code executions in the last hour. Please wait a while.", 429); }

  const { Sandbox } = await import("@vercel/sandbox");
  const credentialOverride = process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
    ? { teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID, token: process.env.VERCEL_TOKEN }
    : {};

  const codeHash = sha256(Buffer.from(src, "utf8"));
  const startedAt = Date.now();
  let sandbox;
  try {
    sandbox = await Sandbox.create({ ...credentialOverride, timeout: budget + 15000, resources: { vcpus: 1 }, networkPolicy: allowNetwork ? "allow-all" : "deny-all", env: {}, persistent: false });
    const lang = LANGUAGES[language];
    const result = await sandbox.runCommand({ cmd: lang.cmd, args: lang.args(src), env: {} });
    const stdout = truncate(await result.stdout()); const stderr = truncate(await result.stderr());
    const durationMs = Date.now() - startedAt;

    await event({ orgId, type: "CODE_EXECUTED", recordId: relatedModelId || orgId, actorEmail, metadata: { language, codeHash, exitCode: result.exitCode, durationMs, networkAllowed: allowNetwork } });
    if (relatedModelId) link({ orgId, subjectId: relatedModelId, type: "EXECUTED_AS", targetType: "ML_CODE_RUN", targetId: relatedModelId, note: `${language} snippet, exit ${result.exitCode}, ${durationMs}ms` });
    if (result.exitCode !== 0) notify({ orgId, title: "Sandbox code execution failed", body: `A ${language} snippet exited with code ${result.exitCode}.`, dedupeKey: `mlstudio:exec:${codeHash}:${startedAt}`, severity: "warning" });

    return { ok: true, exitCode: result.exitCode, stdout, stderr, durationMs };
  } catch (err) {
    return fail(`Sandbox execution failed: ${String(err.message || err).slice(0, 300)}`, 502);
  } finally {
    if (sandbox) { try { await sandbox.stop(); } catch (err) { console.error("ml-studio sandbox stop failed (non-fatal):", err.message); } }
  }
}
