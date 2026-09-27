"use client";

// src/components/business/MlStudioView.js
//
// Business Workspace > AI/ML Studio: the governance-only slice (catalog, model registry, evaluations) plus a
// single governed code-execution primitive (one snippet, one fresh sandbox, never a persistent notebook).
// Owner/admin only throughout -- every action here is either a real external write or real billable compute.

import { useEffect, useState, useCallback } from "react";
import { Note } from "./nas/ui";

const field = "w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm";
const label = "mb-1 block text-xs font-medium text-[var(--inaya-text-muted)]";
const btn = "rounded border border-[var(--inaya-accent)] px-3 py-1.5 text-xs font-medium text-[var(--inaya-accent)] disabled:opacity-50";

export default function MlStudioView({ orgId }) {
  const [models, setModels] = useState([]);
  const [sandbox, setSandbox] = useState({ configured: false });
  const [code, setCode] = useState("print('hello from Inaya AI/ML Studio')");
  const [language, setLanguage] = useState("python");
  const [busy, setBusy] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [m, s] = await Promise.all([
      fetch(`/api/orgs/ml-studio/models?orgId=${orgId}`).then((x) => x.json()).catch(() => ({ models: [] })),
      fetch(`/api/orgs/ml-studio/execute?orgId=${orgId}`).then((x) => x.json()).catch(() => ({ configured: false })),
    ]);
    setModels(m.models || []); setSandbox(s);
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  async function run(e) {
    e.preventDefault(); setBusy(true); setError(""); setRunResult(null);
    const res = await fetch("/api/orgs/ml-studio/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, language, code }) });
    const body = await res.json();
    if (!res.ok) setError(body.error || "Execution failed."); else setRunResult(body);
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">AI/ML Studio</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Register models and datasets, track evaluations, and run one governed code snippet at a time in an isolated sandbox. This is not a persistent notebook -- nothing is remembered between runs.</p>
      </header>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Model registry</h3>
        {!models.length && <Note>No models registered yet.</Note>}
        <div className="space-y-2">
          {models.map((m) => (
            <div key={m.modelId} className="rounded border border-white/10 p-3 text-sm">
              <div className="flex items-center justify-between"><span className="font-medium">{m.modelName} v{m.version}</span><span className="text-xs uppercase text-[var(--inaya-text-muted)]">{m.status}</span></div>
              <div className="mt-1 text-xs text-[var(--inaya-text-muted)]">{m.framework || "framework not set"} &middot; {m.artifact?.sizeBytes ? `${Math.round(m.artifact.sizeBytes / 1024)} KB` : ""} &middot; sha256 {m.artifact?.sha256?.slice(0, 12)}...</div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Code execution (sandboxed)</h3>
        {!sandbox.configured && <Note>No sandbox compute provider is configured on this server.</Note>}
        {sandbox.configured && (
          <form onSubmit={run} className="max-w-xl space-y-3 rounded border border-white/10 p-4">
            <div>
              <label htmlFor="ml-lang" className={label}>Language</label>
              <select id="ml-lang" className={field} value={language} onChange={(e) => setLanguage(e.target.value)}><option value="python">Python</option><option value="node">Node.js</option></select>
            </div>
            <div><label htmlFor="ml-code" className={label}>Code</label><textarea id="ml-code" className={`${field} min-h-[140px] font-mono`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={20000} /></div>
            {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
            <button type="submit" disabled={busy} className={btn}>{busy ? "Running..." : "Run in sandbox"}</button>
            {runResult && (
              <div className="rounded border border-white/10 p-3 text-xs">
                <div>Exit code: <span className="font-mono">{runResult.exitCode}</span> &middot; {runResult.durationMs}ms</div>
                {runResult.stdout && <pre className="mt-2 whitespace-pre-wrap">{runResult.stdout}</pre>}
                {runResult.stderr && <pre className="mt-2 whitespace-pre-wrap text-amber-400">{runResult.stderr}</pre>}
              </div>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
