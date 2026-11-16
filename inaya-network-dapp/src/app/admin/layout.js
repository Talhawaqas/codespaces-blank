"use client";

// app/admin/layout.js
//
// One sign-in for every admin page (founder request, 16 Nov 2026). Before this each page had its own
// passphrase screen and most started "signed out" without checking the existing session, so moving
// between sections asked for the passphrase every time. This layout:
//  - checks the session once (GET /api/admin/session) and shows a single sign-in form if needed;
//  - keeps the session alive while the admin is active (activity re-issues the 30-minute cookie) and
//    signs out after 30 minutes without activity;
//  - puts every admin section in a hamburger menu at the top.
// The pages keep their own sign-in screens only as a fallback if an API call is ever rejected.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const IDLE_LIMIT_MS = 30 * 60 * 1000;
const REFRESH_EVERY_MS = 4 * 60 * 1000;

const SECTIONS = [
  ["/admin", "Enterprise Dashboard"],
  ["/admin/billing", "Billing & invoices"],
  ["/admin/leads", "Leads (outreach)"],
  ["/admin/dataroom", "Data Room"],
  ["/admin/dashboard", "Platform dashboard"],
  ["/admin/security", "Security Layer"],
  ["/admin/fraud", "Fraud & Abuse"],
  ["/admin/audit", "Audit Trail"],
  ["/admin/nodes", "Storage Nodes"],
  ["/admin/faucet", "Faucet"],
  ["/admin/rag", "AI knowledge (RAG)"],
  ["/admin/app-store", "App Store review"],
  ["/admin/hackathon", "Hackathon"],
];

export default function AdminLayout({ children }) {
  const pathname = usePathname();
  const [status, setStatus] = useState("checking"); // checking | in | out
  const [menuOpen, setMenuOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lastActivity = useRef(Date.now());
  const lastRefresh = useRef(Date.now());

  const check = useCallback(async () => {
    try {
      const d = await (await fetch("/api/admin/session", { cache: "no-store" })).json();
      setStatus(d.authed ? "in" : "out");
      lastRefresh.current = Date.now();
      return !!d.authed;
    } catch {
      setStatus("out");
      return false;
    }
  }, []);

  useEffect(() => { check(); }, [check]);
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // Activity keeps the session alive; 30 minutes without activity signs out.
  useEffect(() => {
    if (status !== "in") return undefined;
    const mark = () => { lastActivity.current = Date.now(); };
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const timer = setInterval(async () => {
      const now = Date.now();
      if (now - lastActivity.current > IDLE_LIMIT_MS) {
        await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
        setStatus("out");
        setError("Signed out after 30 minutes without activity.");
        return;
      }
      if (lastActivity.current > lastRefresh.current && now - lastRefresh.current > REFRESH_EVERY_MS) await check();
    }, 30 * 1000);
    return () => { events.forEach((e) => window.removeEventListener(e, mark)); clearInterval(timer); };
  }, [status, check]);

  async function login(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Sign-in failed.");
        return;
      }
      setPassphrase("");
      lastActivity.current = Date.now();
      // Remount the page so it loads its data with the new session.
      window.location.reload();
    } catch {
      setError("Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    setStatus("out");
    setError("");
  }

  if (status === "checking") {
    return <div className="min-h-screen bg-[#060913] text-[#94a3b8] text-sm flex items-center justify-center">Checking your session…</div>;
  }

  if (status === "out") {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={login} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Inaya admin</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase. You stay signed in until 30 minutes without activity.</p>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3" placeholder="Passphrase" autoFocus />
          {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
          <button type="submit" disabled={busy || !passphrase} className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50">{busy ? "Checking…" : "Sign in"}</button>
        </form>
      </div>
    );
  }

  const current = SECTIONS.find(([href]) => href === pathname)?.[1] || "Admin";
  return (
    <div className="min-h-screen bg-[#060913]">
      <div className="sticky top-0 z-[60] bg-[#060913]/95 backdrop-blur border-b border-white/5 px-4 md:px-10 py-3 flex items-center justify-between">
        <div className="relative flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Admin sections"
            aria-expanded={menuOpen}
            className="w-9 h-9 flex flex-col items-center justify-center gap-[5px] rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
          >
            <span className="block w-4 h-[2px] bg-white" />
            <span className="block w-4 h-[2px] bg-white" />
            <span className="block w-4 h-[2px] bg-white" />
          </button>
          <span className="text-white text-sm font-bold">{current}</span>
          {menuOpen && (
            <nav className="absolute left-0 top-11 w-64 bg-[#0b1120] border border-white/10 rounded-xl shadow-2xl py-2">
              {SECTIONS.map(([href, label]) => (
                <a key={href} href={href} className={`block px-4 py-2 text-sm ${href === pathname ? "text-[#00f2fe] font-bold bg-white/5" : "text-[#cbd5e1] hover:bg-white/5"}`}>{label}</a>
              ))}
            </nav>
          )}
        </div>
        <button onClick={logout} className="text-xs px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-[#cbd5e1] hover:bg-white/10">Log out</button>
      </div>
      {children}
    </div>
  );
}
