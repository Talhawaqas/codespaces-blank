"use client";

// app/meet/[token]/page.js
//
// The public join link for Inaya Meet (Internxt-inspired SOW, Workstream C, §7.10). Works for both
// an authenticated org member (their session cookie resolves their email automatically) and a guest
// with no Inaya account (just a display name) -- see src/app/api/meet/rooms/[roomId]/join/route.js's
// dual-auth handling. The token itself never reveals who else is in the meeting or any room secret;
// it only unlocks the join request.

import { use, useEffect, useState } from "react";
import BrandHeader from "../../../components/BrandHeader";
import { MeetRoom } from "../../../components/business/meet/MeetView";
import { localDeviceId } from "../../../components/business/endpoint/DevicesView";

const input = "w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]";
const primary = "w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || "Something went wrong."), { status: r.status, code: d.code }); return d; };

export default function MeetJoinPage({ params }) {
  const { token } = use(params);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [guestName, setGuestName] = useState("");
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(null); // { roomId, orgId, me: {...}, guestAuth: {...} | null }

  useEffect(() => { j(`/api/meet/by-token/${token}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);

  const join = async () => {
    setBusy(true); setError("");
    try {
      const r = await j(`/api/meet/rooms/${info.roomId}/join?orgId=${info.orgId}`, { method: "POST", body: JSON.stringify({ orgId: info.orgId, joinToken: token, deviceId: localDeviceId(), guestName: guestName || undefined }) });
      setJoined({ roomId: info.roomId, orgId: info.orgId, email: r.email || null, guestAuth: r.isGuest ? { participantId: r.participantId, guestToken: r.guestToken } : null });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (joined) {
    return (
      <div className="min-h-screen bg-[#05070c] p-4">
        <MeetRoom orgId={joined.orgId} email={joined.email} roomId={joined.roomId} initialGuestAuth={joined.guestAuth} onLeave={() => { setJoined(null); setInfo(null); j(`/api/meet/by-token/${token}`).then(setInfo).catch((e) => setError(e.message)); }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#05070c] flex flex-col items-center px-4 py-10">
      <BrandHeader />
      <div className="w-full max-w-sm mt-10 bg-white/[0.03] border border-white/10 rounded-2xl p-6">
        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
        {!info && !error && <p className="text-xs text-[#8a96ab]">Checking this link...</p>}
        {info && (
          <>
            <h1 className="text-white font-bold text-lg mb-1">{info.title}</h1>
            <p className="text-[#8a96ab] text-xs mb-4">
              {info.guestAccess === "forbidden" ? "Sign in to your Inaya account to join this meeting." : "Enter your name to join, or sign in first if you already have an Inaya account."}
            </p>
            {info.guestAccess !== "forbidden" && (
              <input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Your name" className={input + " mb-3"} maxLength={80} />
            )}
            <button onClick={join} disabled={busy || (info.guestAccess !== "forbidden" && !guestName.trim())} className={primary}>
              {busy ? "Joining..." : "Join meeting"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
