"use client";

// /reserve/manage/{token} -- a guest's own reservation, from the link in their confirmation email (Hospitality SOW 8.8).
// View it, cancel within the restaurant's notice period, or leave feedback after the visit. The link is the only
// credential: the server stores a hash of it and it stops working a week after the visit.

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
const btn = "font-semibold rounded-lg px-4 py-2.5 disabled:opacity-50";
const STATUS = { CONFIRMED: "Confirmed", PENDING_CONFIRMATION: "Waiting for the restaurant to confirm", REQUESTED: "Waiting for the restaurant to confirm", CANCELLED: "Cancelled", DECLINED: "Not confirmed", ARRIVED: "Arrived", SEATED: "Seated", COMPLETED: "Completed", NO_SHOW: "Marked as not attended" };

export default function ManageReservationPage() {
  const { token } = useParams();
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const load = useCallback(() => api(`/api/reserve/manage/${token}`).then((d) => setR(d.reservation)).catch((e) => setError(e.message)), [token]);
  useEffect(() => { load(); }, [load]);
  const act = async (body, ok) => { setBusy(true); setMsg(""); try { await api(`/api/reserve/manage/${token}`, { method: "POST", body: JSON.stringify(body) }); setMsg(ok); await load(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } };

  if (error) return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6"><p className="text-slate-700">{error}</p></main>;
  if (!r) return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6"><p className="text-slate-500">Loading…</p></main>;
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 p-4 sm:p-8">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-200 p-5 sm:p-8 space-y-4">
        <h1 className="text-2xl font-bold">{r.business}</h1>
        <p className="text-slate-600">{r.location.name}{r.location.address ? ` · ${r.location.address}` : ""}{r.location.phone ? ` · ${r.location.phone}` : ""}</p>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-500">Reference</dt><dd className="font-semibold">{r.ref}</dd>
          <dt className="text-slate-500">Name</dt><dd>{r.name}</dd>
          <dt className="text-slate-500">When</dt><dd>{new Date(`${r.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at {r.time} ({r.timeZone})</dd>
          <dt className="text-slate-500">Guests</dt><dd>{r.partySize}</dd>
          <dt className="text-slate-500">Status</dt><dd>{STATUS[r.status] || r.status}</dd>
        </dl>
        {msg && <p role="status" className="text-sm text-slate-700 bg-slate-100 rounded-lg px-3 py-2">{msg}</p>}
        {r.canCancel && <button className={`${btn} bg-red-700 text-white`} disabled={busy} onClick={() => { if (window.confirm("Cancel this reservation?")) act({ action: "cancel" }, "Your reservation is cancelled. We've sent you an email to confirm."); }}>Cancel reservation</button>}
        {!r.canCancel && ["CONFIRMED", "PENDING_CONFIRMATION", "REQUESTED"].includes(r.status) && <p className="text-sm text-slate-600">Online cancellation closes {r.cancelNoticeHours} hours before the reservation. Please call {r.location.phone || "the restaurant"} to make a change.</p>}
        {r.canGiveFeedback && (
          <form className="space-y-3 border-t border-slate-200 pt-4" onSubmit={(e) => { e.preventDefault(); act({ action: "feedback", rating, comment }, "Thank you for your feedback."); }}>
            <h2 className="font-semibold">How was your visit?</h2>
            <label className="text-sm font-medium block">Rating
              <select className="block mt-1 border border-slate-300 rounded-lg px-3 py-2" value={rating} onChange={(e) => setRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} out of 5</option>)}</select>
            </label>
            <label className="text-sm font-medium block">Comment (optional)<textarea className="block mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 h-20" maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
            <button className={`${btn} bg-teal-700 text-white`} disabled={busy}>Send feedback</button>
          </form>
        )}
        {r.feedbackGiven && <p className="text-sm text-slate-600">Thank you, we have your feedback.</p>}
      </div>
    </main>
  );
}
