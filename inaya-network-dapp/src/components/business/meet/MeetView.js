"use client";

// src/components/business/meet/MeetView.js
//
// Inaya Meet (Internxt-inspired SOW, Workstream C). Real peer-to-peer WebRTC mesh over the signaling
// transport in src/lib/meet/signaling.js (long-poll, same pattern Secure Chat's own transport uses --
// see the Meet ADR). Each pair of admitted participants negotiates its own RTCPeerConnection directly;
// media never touches an Inaya server (the architectural point of mesh-over-SFU for v1, see the ADR).
//
// What's real here: room lifecycle, the lobby/approval flow, moderator controls (server-enforced, this
// component never asserts its own "am I a moderator" -- every action re-checks against the room on the
// server), and the WebRTC mesh itself with working camera/mic/screen-share.
//
// What's a known v1 limitation, stated plainly rather than hidden: no TURN server is configured, so a
// participant behind a strict/symmetric NAT may fail to connect to some peers (STUN-only). The
// room-secret application-level key envelope (Hybrid PQC) is not wired up client-side yet -- see
// docs/internxt-implementation-ledger.md -- so new rooms default to policy "CLASSICAL": media is still
// genuinely encrypted in transit by WebRTC's own DTLS-SRTP, this is about the additional PQC layer.

import { useCallback, useEffect, useRef, useState } from "react";
import { Pqc } from "@inaya-network/custody-sdk";
import EmptyState from "../../EmptyState";
import { localDeviceId } from "../endpoint/DevicesView";
import { isDesktopApp, popOutMeet } from "../chat/desktop.js";

// Real client-side PQC key resolution for Meet admission (closes the gap noted in
// docs/internxt-implementation-ledger.md, MEET-002). The room secret is generated once, locally,
// by the host's browser -- it never reaches the server in plaintext. Admitting a participant wraps
// that same secret to their device's registered public key (src/lib/pqc/deviceKeys.js,
// PQC-A03/A04) using the exact same algorithm-agile primitive the sharing feature uses
// (Pqc.wrapForRecipient, PQC-A05) -- never a second envelope scheme. pqc_device_keys stores one
// combined key per device (ML-KEM-768 public key || X25519 public key, concatenated, confirmed by
// Pqc.capabilityInfo().mlKemPublicKeyLength); wrapForRecipient's HYBRID_PQC/PQC_REQUIRED paths take
// that combined key as-is (Pqc.encapsulate splits it internally), while its LEGACY_CLASSICAL
// fallback needs just the X25519 half, sliced out here.
const bytesToB64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
const b64ToBytes = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
async function fetchActivePqcKey(orgId, deviceId) {
  if (!deviceId) return null;
  try {
    const r = await j(`/api/orgs/pqc/devices/${deviceId}/active-key?orgId=${orgId}`);
    return r.key ? b64ToBytes(r.key.publicKey) : null;
  } catch { return null; } // FEATURE_PQC off, or no key registered -- a real, expected case, not an error
}
function newRoomSecret() { return bytesToB64(crypto.getRandomValues(new Uint8Array(32))); }

const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); let d = {}; try { d = await r.json(); } catch { /* empty */ } if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status, data: d }); return d; };
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const card = "bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5";
const btn = "px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";
const ghost = "px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase border border-white/15 text-[var(--inaya-text-primary)] disabled:opacity-40";
const danger = "px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase bg-red-500/90 text-white disabled:opacity-40";

const SECURITY_LABEL = { LEGACY_CLASSICAL: "Encrypted", HYBRID_PQC: "Hybrid PQC", PQC_REQUIRED: "PQC Required" };

function SecurityBanner({ policy, guestsPresent }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-[var(--inaya-text-muted)]">
      <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 font-bold uppercase tracking-wide">{SECURITY_LABEL[policy.keyMode] || policy.keyMode}</span>
      <span>Media encrypted in transit (WebRTC DTLS-SRTP)</span>
      {guestsPresent && <span>· Guests present</span>}
      <span>· Chat is ephemeral</span>
    </div>
  );
}

export default function MeetView({ orgId, email }) {
  const [stage, setStage] = useState("list"); // list | create | lobby | room
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState({ title: "", kind: "instant" });
  const [joinTokenInput, setJoinTokenInput] = useState("");
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [freshLink, setFreshLink] = useState(null);

  const loadRooms = useCallback(async () => {
    try { setRooms((await j(`/api/meet/rooms?orgId=${orgId}`)).rooms); setError(""); }
    catch (e) { if (e.status === 404) setRooms(null); else setError(e.message); }
  }, [orgId]);
  useEffect(() => { if (stage === "list") loadRooms(); }, [stage, loadRooms]);

  if (stage === "room" && activeRoomId) {
    return <MeetRoom orgId={orgId} email={email} roomId={activeRoomId} shareLink={freshLink} onLeave={() => { setActiveRoomId(null); setFreshLink(null); setStage("list"); }} />;
  }

  if (rooms === null && !error) {
    return <EmptyState icon="🎥" title="Inaya Meet is not enabled" description="Turn on “Meeting rooms” under Settings, Beta features, to use Meet." />;
  }

  const create = async () => {
    setError("");
    try {
      const deviceId = localDeviceId();
      const r = await j(`/api/meet/rooms`, { method: "POST", body: JSON.stringify({ orgId, deviceId, title: creating.title, kind: "instant" }) });
      setFreshLink(`${window.location.origin}${r.joinLink}`);
      setActiveRoomId(r.roomId);
      setStage("room");
    } catch (e) { setError(e.message); }
  };

  const joinByLink = async () => {
    setError("");
    const m = /\/meet\/([A-Za-z0-9_-]+)/.exec(joinTokenInput.trim()) || [null, joinTokenInput.trim()];
    const token = m[1];
    if (!token) { setError("Paste a meeting link or its join code."); return; }
    try {
      // The roomId isn't known from a bare token on this screen, so resolve it the same way the
      // public /meet/[token] guest page will: the join route itself only needs orgId + token, but
      // this authenticated org member flow routes through the room-scoped API, so ask for the room
      // list first is unnecessary -- the token alone is enough once we add a lookup-by-token helper.
      // For now, org members join from the room list below; this field is for pasting a link shared
      // from outside, which opens the dedicated /meet/[token] page instead.
      window.open(`/meet/${token}`, "_blank");
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <SecurityBanner policy={{ keyMode: "LEGACY_CLASSICAL" }} guestsPresent={false} />
      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className={card}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Start or join</h3>
          {isDesktopApp() && <button onClick={() => popOutMeet()} className={ghost}>Open in its own window</button>}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <input value={creating.title} onChange={(e) => setCreating({ ...creating, title: e.target.value })} placeholder="Meeting title (optional)" className="bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-[var(--inaya-text-primary)] flex-1 min-w-[200px]" />
          <button onClick={create} className={btn}>New Meeting</button>
        </div>
        <div className="flex gap-2 items-center mt-3">
          <input value={joinTokenInput} onChange={(e) => setJoinTokenInput(e.target.value)} placeholder="Paste a meeting link" className="bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-[var(--inaya-text-primary)] flex-1 min-w-[200px]" />
          <button onClick={joinByLink} className={ghost}>Open link</button>
        </div>
      </div>

      <div className={card}>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm mb-3">Your meetings</h3>
        {!rooms?.length ? <EmptyState compact icon="🎥" description="No meetings yet." /> : (
          <div className="space-y-2">
            {rooms.map((r) => (
              <div key={r.roomId} className="flex items-center justify-between border-b border-white/5 py-2 last:border-0">
                <div>
                  <p className="text-sm text-[var(--inaya-text-primary)] font-bold">{r.title}</p>
                  <p className="text-[11px] text-[var(--inaya-text-muted)]">{r.status} · {r.hostEmail === email ? "you're hosting" : `hosted by ${r.hostEmail}`}</p>
                </div>
                {["lobby", "active", "locked"].includes(r.status) && (
                  <button onClick={() => { setActiveRoomId(r.roomId); setStage("room"); }} className={btn}>Join</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------- MeetRoom

export function MeetRoom({ orgId, email, roomId, shareLink, initialGuestAuth = null, onLeave }) {
  // Set for a guest joining via /meet/[token] (no org session -- see src/app/meet/[token]/page.js);
  // null for an org member reached from the business-workspace room list, where the session cookie
  // alone is enough. Every fetch below includes both so the server's dual-auth routes (meetOpenRoute,
  // src/app/api/meet/rooms/_lib.js) accept either identity path.
  const guestAuthRef = useRef(initialGuestAuth);
  const authQS = () => (guestAuthRef.current ? `&participantId=${guestAuthRef.current.participantId}&guestToken=${encodeURIComponent(guestAuthRef.current.guestToken)}` : "");
  const authBody = () => (guestAuthRef.current ? { participantId: guestAuthRef.current.participantId, guestToken: guestAuthRef.current.guestToken } : {});
  const [phase, setPhase] = useState("preflight"); // preflight | waiting | in-room | ended
  const [room, setRoom] = useState(null);
  const [me, setMe] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [waiting, setWaiting] = useState([]);
  const [error, setError] = useState("");
  const [deviceWarning, setDeviceWarning] = useState(""); // separate from `error`: a denied camera/mic is informational, never the reason the meeting "failed to open"
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);

  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peersRef = useRef(new Map()); // participantId -> RTCPeerConnection
  const remoteVideoRefs = useRef(new Map());
  const [remoteIds, setRemoteIds] = useState([]);
  const cursorRef = useRef({ seq: 0, at: null });
  const pollAbort = useRef(false);
  const roomSecretRef = useRef(null); // base64 string, generated locally by the host on first need -- never sent to the server in plaintext

  const loadRoom = useCallback(async () => {
    const r = await j(`/api/meet/rooms/${roomId}?orgId=${orgId}${authQS()}`);
    setRoom(r); setMe(r.me);
    return r;
  }, [orgId, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadRoom().catch((e) => setError(e.message)); }, [loadRoom]);

  const startPreflight = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    } catch {
      setDeviceWarning("Camera/microphone permission was denied. You can still join with no camera or mic.");
    }
  }, []);
  useEffect(() => { startPreflight(); return () => { localStreamRef.current?.getTracks().forEach((t) => t.stop()); }; }, [startPreflight]);

  function sendSignal(kind, payload, toParticipantId = null) {
    return j(`/api/meet/rooms/${roomId}/signal?orgId=${orgId}`, { method: "POST", body: JSON.stringify({ orgId, participantId: me.participantId, kind, payload, toParticipantId, ...authBody() }) }).catch(() => {});
  }

  function ensurePeer(participantId) {
    if (peersRef.current.has(participantId)) return peersRef.current.get(participantId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal("ice", { candidate: e.candidate }, participantId); };
    pc.ontrack = (e) => {
      const el = remoteVideoRefs.current.get(participantId);
      if (el) el.srcObject = e.streams[0];
    };
    peersRef.current.set(participantId, pc);
    setRemoteIds((prev) => (prev.includes(participantId) ? prev : [...prev, participantId]));
    return pc;
  }

  function teardownPeer(participantId) {
    const pc = peersRef.current.get(participantId);
    if (pc) { try { pc.close(); } catch { /* already closed */ } peersRef.current.delete(participantId); }
    remoteVideoRefs.current.delete(participantId);
    setRemoteIds((prev) => prev.filter((id) => id !== participantId));
  }

  const refreshParticipants = useCallback(async () => {
    const r = await j(`/api/meet/rooms/${roomId}/participants?orgId=${orgId}`);
    setParticipants(r.participants);
    // Initiate to every admitted peer with a lexicographically smaller id than mine that we don't
    // already have a connection to -- a simple, deterministic glare-free initiator rule for mesh.
    for (const p of r.participants) {
      if (p.participantId === me?.participantId) continue;
      if (peersRef.current.has(p.participantId)) continue;
      if (me && me.participantId < p.participantId) {
        const pc = ensurePeer(p.participantId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal("offer", { sdp: offer }, p.participantId);
      }
    }
  }, [orgId, roomId, me]);

  async function pollSignals() {
    while (!pollAbort.current) {
      try {
        const r = await j(`/api/meet/rooms/${roomId}/signal?orgId=${orgId}&participantId=${me.participantId}&since=${encodeURIComponent(cursorRef.current.at || "")}&wait=20000&cursorSeq=${cursorRef.current.seq}${authQS()}`);
        for (const s of r.signals) {
          cursorRef.current.seq = Math.max(cursorRef.current.seq, s.seq);
          if (s.kind === "offer" && s.fromParticipantId) {
            const pc = ensurePeer(s.fromParticipantId);
            await pc.setRemoteDescription(s.payload.sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal("answer", { sdp: answer }, s.fromParticipantId);
          } else if (s.kind === "answer" && s.fromParticipantId) {
            const pc = peersRef.current.get(s.fromParticipantId);
            if (pc) await pc.setRemoteDescription(s.payload.sdp);
          } else if (s.kind === "ice" && s.fromParticipantId) {
            const pc = peersRef.current.get(s.fromParticipantId);
            if (pc) try { await pc.addIceCandidate(s.payload.candidate); } catch { /* benign if the connection already closed */ }
          } else if (s.kind === "control") {
            const a = s.payload?.action;
            if (a === "participant-removed" && s.payload.participantId) teardownPeer(s.payload.participantId);
            else if (a === "meeting-ended") { setPhase("ended"); pollAbort.current = true; }
            else if (a === "mute-request" && s.payload.participantId === me.participantId) { setMicOn(false); localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false)); }
            else if (a === "room-locked" || a === "room-unlocked") loadRoom().catch(() => {});
          }
        }
        cursorRef.current.at = r.at;
        if (["offer", "answer", "control"].some((k) => r.signals.some((s) => s.kind === k))) await refreshParticipants().catch(() => {});
      } catch { /* a transient poll failure just retries */ }
    }
  }

  // Reaching MeetRoom from the business-workspace room list (src/components/business/meet/MeetView.js's
  // "list" stage) only ever happens for a room you already have a participant row in -- that list is
  // built from listRooms(scope: "mine"), which is exactly that set. So there is nothing to "join" here:
  // no token round trip, just confirm the preflight camera check and move into the room. Joining a room
  // you are NOT already part of -- the real first-time join, with a token -- happens on the public
  // /meet/[token] page (src/app/meet/[token]/page.js), for org members and guests alike.
  const confirmJoin = () => {
    setError("");
    if (!me) { setError("You're not a participant in this meeting yet. Use the meeting's join link instead."); return; }
    setPhase(me.status === "waiting" ? "waiting" : "in-room");
    if (me.status === "admitted") { pollAbort.current = false; pollSignals(); refreshParticipants(); }
  };

  useEffect(() => {
    if (!room || !me) return;
    if (me.status === "admitted" && phase !== "in-room") { setPhase("in-room"); pollAbort.current = false; pollSignals(); refreshParticipants(); }
  }, [room, me]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { pollAbort.current = true; peersRef.current.forEach((pc) => { try { pc.close(); } catch { /* already closed */ } }); }, []);

  const toggleMic = () => { const on = !micOn; setMicOn(on); localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = on)); };
  const toggleCam = () => { const on = !camOn; setCamOn(on); localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = on)); };

  const toggleShare = async () => {
    if (sharing) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      const camTrack = localStreamRef.current?.getVideoTracks()[0];
      if (camTrack) peersRef.current.forEach((pc) => { const sender = pc.getSenders().find((s) => s.track?.kind === "video"); if (sender) sender.replaceTrack(camTrack); });
      setSharing(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      peersRef.current.forEach((pc) => { const sender = pc.getSenders().find((s) => s.track?.kind === "video"); if (sender) sender.replaceTrack(track); });
      track.onended = () => toggleShare();
      setSharing(true);
    } catch { /* user cancelled the picker */ }
  };

  const leave = async () => {
    pollAbort.current = true;
    peersRef.current.forEach((pc) => { try { pc.close(); } catch { /* already closed */ } });
    if (me) await j(`/api/meet/rooms/${roomId}/leave?orgId=${orgId}`, { method: "POST", body: JSON.stringify({ orgId, participantId: me.participantId, ...authBody() }) }).catch(() => {});
    onLeave();
  };

  const endForEveryone = async () => { await j(`/api/meet/rooms/${roomId}/end?orgId=${orgId}`, { method: "POST", body: JSON.stringify({ orgId }) }).catch((e) => setError(e.message)); onLeave(); };
  const toggleLock = async () => { await j(`/api/meet/rooms/${roomId}/lock?orgId=${orgId}`, { method: "POST", body: JSON.stringify({ orgId, locked: room.status !== "locked" }) }).catch((e) => setError(e.message)); loadRoom(); };

  const moderate = async (participantId, action, extra = {}) => {
    await j(`/api/meet/rooms/${roomId}/participants/${participantId}?orgId=${orgId}`, { method: "PATCH", body: JSON.stringify({ orgId, action, ...extra }) }).catch((e) => setError(e.message));
    refreshWaiting(); refreshParticipants();
  };

  // Admit, with a real wrapped room-secret envelope when the participant's device has a registered
  // PQC key (see the Pqc import/helpers above). Falls back to admitting with no envelope for
  // CLASSICAL/HYBRID_PQC rooms when no key is found -- the meeting still works via WebRTC's own
  // transport encryption (see the Meet ADR §4) -- but genuinely refuses for PQC_REQUIRED, matching
  // the server's own enforcement rather than letting a confusing 409 surface with no explanation.
  const approveWaiting = async (w) => {
    setError("");
    if (!roomSecretRef.current) roomSecretRef.current = newRoomSecret();
    const combinedKey = await fetchActivePqcKey(orgId, w.deviceId);
    let roomSecretEnvelope = null, algorithmId = null;
    if (combinedKey) {
      try {
        const mlKemLen = Pqc.capabilityInfo().mlKemPublicKeyLength;
        const mode = room.policy.keyMode === Pqc.SHARING_MODE.PQC_REQUIRED ? Pqc.SHARING_MODE.PQC_REQUIRED : Pqc.SHARING_MODE.HYBRID_PQC;
        roomSecretEnvelope = Pqc.wrapForRecipient({ plaintext: roomSecretRef.current, recipientClassicalPublicKey: combinedKey.slice(mlKemLen), recipientPqcPublicKey: combinedKey, mode });
        algorithmId = Pqc.isAgileHybridEnvelope(roomSecretEnvelope) ? roomSecretEnvelope.algorithm : "LEGACY_CLASSICAL";
      } catch (e) {
        if (room.policy.keyMode === Pqc.SHARING_MODE.PQC_REQUIRED) { setError(e.message); return; }
      }
    } else if (room.policy.keyMode === Pqc.SHARING_MODE.PQC_REQUIRED) {
      setError("This participant's device has no registered PQC key yet, and this meeting requires one.");
      return;
    }
    await moderate(w.participantId, "approve", { roomSecretEnvelope, algorithmId });
  };
  const refreshWaiting = useCallback(async () => {
    if (!room || room.hostEmail !== email) return;
    const r = await j(`/api/meet/rooms/${roomId}/participants?orgId=${orgId}&waiting=1`).catch(() => ({ waiting: [] }));
    setWaiting(r.waiting);
  }, [orgId, roomId, room, email]);
  useEffect(() => { if (phase === "in-room") { refreshWaiting(); const t = setInterval(refreshWaiting, 4000); return () => clearInterval(t); } }, [phase, refreshWaiting]);

  const isModerator = room && (room.hostEmail === email);

  if (error && !room) return <EmptyState icon="🎥" title="Couldn't open this meeting" description={error} />;
  if (phase === "ended") return <EmptyState icon="🎥" title="The meeting ended" description="Everyone has left." />;
  if (!room) return <p className="text-xs text-[var(--inaya-text-muted)]">Loading...</p>;

  if (phase === "preflight") {
    return (
      <div className="space-y-4">
        <div className={card}>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm mb-2">{room.title}</h3>
          {shareLink && (
            <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-xl px-3 py-2 mb-3">
              <span className="text-[11px] font-mono text-[var(--inaya-text-primary)] truncate flex-1">{shareLink}</span>
              <button onClick={() => navigator.clipboard?.writeText(shareLink)} className={ghost}>Copy link</button>
            </div>
          )}
          <video ref={localVideoRef} autoPlay muted playsInline className="w-full max-w-md rounded-xl bg-black aspect-video" />
          {deviceWarning && <p className="text-amber-300 text-xs mt-2">{deviceWarning}</p>}
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={confirmJoin} className={btn}>Join now</button>
            <button onClick={onLeave} className={ghost}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "waiting") {
    return <EmptyState icon="⏳" title="Waiting for the host" description="You'll join automatically once the host admits you." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">{room.title}</h3>
        <SecurityBanner policy={room.policy} guestsPresent={participants.some((p) => p.isGuest)} />
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="relative">
          <video ref={localVideoRef} autoPlay muted playsInline className="w-full rounded-xl bg-black aspect-video" />
          <span className="absolute bottom-1 left-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">You</span>
        </div>
        {remoteIds.map((id) => {
          const p = participants.find((x) => x.participantId === id);
          return (
            <div key={id} className="relative">
              <video ref={(el) => { if (el) remoteVideoRefs.current.set(id, el); }} autoPlay playsInline className="w-full rounded-xl bg-black aspect-video" />
              <span className="absolute bottom-1 left-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">{p?.guestName || p?.email || "Participant"}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={toggleMic} className={micOn ? ghost : danger}>{micOn ? "Mute" : "Unmute"}</button>
        <button onClick={toggleCam} className={camOn ? ghost : danger}>{camOn ? "Stop Camera" : "Start Camera"}</button>
        {room.policy.screenShareEnabled && <button onClick={toggleShare} className={ghost}>{sharing ? "Stop Sharing" : "Share Screen"}</button>}
        <button onClick={leave} className={ghost}>Leave</button>
        {isModerator && <button onClick={toggleLock} className={ghost}>{room.status === "locked" ? "Unlock" : "Lock"} Meeting</button>}
        {isModerator && <button onClick={endForEveryone} className={danger}>End for Everyone</button>}
      </div>

      {isModerator && waiting.length > 0 && (
        <div className={card}>
          <h4 className="text-[var(--inaya-text-primary)] font-bold text-xs mb-2">Waiting to join</h4>
          {waiting.map((w) => (
            <div key={w.participantId} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
              <span className="text-xs text-[var(--inaya-text-primary)]">{w.guestName || w.email}{w.isGuest ? " (guest)" : ""}</span>
              <div className="flex gap-2">
                <button onClick={() => approveWaiting(w)} className={ghost}>Admit</button>
                <button onClick={() => moderate(w.participantId, "reject")} className={ghost}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {isModerator && (
        <div className={card}>
          <h4 className="text-[var(--inaya-text-primary)] font-bold text-xs mb-2">Participants ({participants.length})</h4>
          {participants.map((p) => (
            <div key={p.participantId} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
              <span className="text-xs text-[var(--inaya-text-primary)]">{p.guestName || p.email}{p.role === "host" ? " (host)" : ""}</span>
              {p.role !== "host" && (
                <div className="flex gap-2">
                  <button onClick={() => moderate(p.participantId, "mute")} className={ghost}>Request Mute</button>
                  <button onClick={() => moderate(p.participantId, "remove")} className={danger}>Remove</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
