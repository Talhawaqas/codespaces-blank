"use client";

// /u/{token} -- unsubscribe confirmation page for marketing email. Unsubscribing takes one click on a POST
// (a GET never unsubscribes, so email security scanners that open links can't unsubscribe people by accident).

import { useState } from "react";
import { useParams } from "next/navigation";

export default function Unsubscribe() {
  const { token } = useParams();
  const [state, setState] = useState({ step: "ask" });
  const go = async () => {
    setState({ step: "busy" });
    try {
      const res = await fetch(`/api/m/unsubscribe/${encodeURIComponent(token)}`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Something went wrong. Please try again.");
      setState({ step: "done", businessName: d.businessName });
    } catch (e) { setState({ step: "error", error: e.message }); }
  };
  return (
    <main className="min-h-screen bg-[#f5f6f8] text-[#1d2433] px-4 py-16" style={{ colorScheme: "light" }}>
      <div className="max-w-md mx-auto bg-white border border-[#e3e6eb] rounded-xl p-6 shadow-sm space-y-4 text-center">
        {state.step === "done" ? <>
          <h1 className="text-xl font-semibold">You&apos;re unsubscribed</h1>
          <p className="text-[#475467]">You won&apos;t get marketing emails from {state.businessName} any more. Messages about bookings you make will still reach you.</p>
        </> : <>
          <h1 className="text-xl font-semibold">Unsubscribe from these emails?</h1>
          <p className="text-[#475467]">You&apos;ll stop receiving newsletters, offers and follow-ups from this sender.</p>
          <button onClick={go} disabled={state.step === "busy"} className="px-5 py-2.5 rounded-lg bg-[#0b6e75] text-white font-medium disabled:opacity-50">{state.step === "busy" ? "Unsubscribing…" : "Unsubscribe"}</button>
          {state.step === "error" && <p className="text-[#b42318] text-sm">{state.error}</p>}
        </>}
      </div>
    </main>
  );
}
