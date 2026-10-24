// src/lib/healthReport.js
//
// Daily health report. A cloud AI routine checks production at 08:30 PKT and
// posts its summary to POST /api/health/report (bearer HEALTH_REPORT_TOKEN);
// at 09:00 PKT the cron /api/cron/health-report-email emails it, with a fresh
// live check, to HEALTH_REPORT_EMAIL. No report by then = the email says the
// routine did not report, so a silent failure is still noticed.

import { connectToDatabase } from "./mongodb.js";

export const REPORT_MAX_CHARS = 8000;
export const REPORT_STATUSES = ["ok", "problem"];

const pkDay = (d = new Date()) => new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);

async function reports() {
  const { db } = await connectToDatabase();
  return db.collection("health_reports");
}

/** Stores today's report (Pakistan date), replacing an earlier one from the same day. */
export async function saveHealthReport({ status, summary }) {
  if (!REPORT_STATUSES.includes(status)) return { error: "status must be ok or problem." };
  const text = String(summary || "").trim();
  if (!text) return { error: "summary is required." };
  const col = await reports();
  const day = pkDay();
  await col.updateOne(
    { day },
    { $set: { day, status, summary: text.slice(0, REPORT_MAX_CHARS), receivedAt: new Date().toISOString() } },
    { upsert: true }
  );
  return { day };
}

export async function getTodaysHealthReport() {
  return (await reports()).findOne({ day: pkDay() });
}

/** The same check the uptime monitor runs: is the database answering? */
export async function liveDatabaseCheck() {
  const started = Date.now();
  try {
    const { db } = await connectToDatabase();
    await Promise.race([db.command({ ping: 1 }), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
    return { ok: true, ms: Date.now() - started };
  } catch {
    return { ok: false };
  }
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Subject + bodies for the 09:00 email. */
export function buildHealthEmail({ report, live, day }) {
  const liveLine = live.ok ? `Live check at 09:00: database OK (${live.ms} ms).` : "Live check at 09:00: the database is NOT answering.";
  let headline, body;
  if (!report) {
    headline = "No report from the daily AI check";
    body = "The AI health check did not send a report this morning. It may have failed to run; check it at https://claude.ai/code/routines.";
  } else if (report.status === "problem" || !live.ok) {
    headline = "Problem found";
    body = report.summary;
  } else {
    headline = "All clear";
    body = report.summary;
  }
  const subject = `Inaya daily health report, ${day}: ${headline}`;
  const text = `${headline}\n\n${liveLine}\n\n${body}\n\nUptime monitor history: https://github.com/Talhawaqas/codespaces-blank/actions/workflows/uptime-check.yml`;
  const colour = headline === "All clear" ? "#067647" : "#b42318";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;color:#1f2328">
<p style="font-weight:800;font-size:18px;color:#10151f">INAYA <span style="color:#007a8f">NETWORK</span> · Daily health report</p>
<p style="font-size:16px;font-weight:700;color:${colour}">${esc(headline)}</p>
<p>${esc(liveLine)}</p>
<pre style="white-space:pre-wrap;font-family:inherit;background:#f5f6f8;border:1px solid #e4e7ec;border-radius:6px;padding:12px">${esc(body)}</pre>
<p style="font-size:12px;color:#5b6470">Uptime monitor history: <a href="https://github.com/Talhawaqas/codespaces-blank/actions/workflows/uptime-check.yml">GitHub Actions</a></p>
</div>`;
  return { subject, text, html };
}
