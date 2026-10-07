# ADR: Inaya Meet — signaling and media architecture

Status: accepted 2026-10-07. Scope: Inaya Meet (Internxt-inspired SOW, Workstream C).
Companion: `docs/security/meet-threat-model.md`.

## 1. Decision

Meet ships v1 with **peer-to-peer (mesh) media** and **signaling over the existing long-poll/SSE real-time pattern** — not a Selective
Forwarding Unit (SFU). This is a deliberate, documented tradeoff, not an oversight.

## 2. Why not an SFU in v1

An SFU is a persistent server process routing live UDP media packets between participants continuously. Vercel serverless functions
cannot host that: no persistent process, no long-lived sockets, no raw UDP. Standing one up requires a second always-on host (a VPS,
Fly.io, Render), which is new infrastructure and cost outside this SOW's own stated goal of staying deployable exactly like everything
else built so far. The SOW's §7.4 recommends an SFU "for future scalability" but does not mandate it for v1, and explicitly forbids the
SFU becoming a plaintext media termination point under any E2EE claim (§7.5, §7.25) — which an SFU, even if built, would need frame-level
encryption (Insertable Streams / Encoded Transform) to honestly satisfy.

## 3. What v1 actually does

```
Participant A                                    Participant B
  Camera/Mic                                        Camera/Mic
      │                                                  │
  RTCPeerConnection ──── direct encrypted WebRTC ──── RTCPeerConnection
      │        (DTLS-SRTP, never touches Inaya servers)  │
      └──────────────── signaling only ─────────────────┘
                              │
                    Inaya API (long-poll/SSE)
                 SDP offer/answer, ICE candidates,
                   room-control events (admit/
                   remove/lock), no media, no keys
```

* **Signaling** rides the same long-poll/SSE transport Secure Chat's real-time layer already uses (small, bursty request/response
  traffic — exactly what Vercel serverless handles well). No new real-time transport is invented.
* **Media is genuinely peer-to-peer.** Once two browsers' `RTCPeerConnection`s negotiate, audio/video/screen-share flows directly
  between them over DTLS-SRTP. It never reaches an Inaya server at all — which is a *stronger* privacy property than any SFU
  architecture provides (there is nothing server-side to compromise), at the direct cost of not scaling past a handful of
  participants.
* **Room size policy** defaults conservatively (6) and is configurable per organization, never silently raised — the SOW explicitly
  forbids hard-coding either of Internxt's inconsistent participant-count numbers (§1.5, §7.37.17); this project instead picks a number
  honestly scoped to what mesh topology can actually support, stated as an engineering default, not a marketing claim.

## 4. Media security boundary

WebRTC's DTLS-SRTP is **transport** encryption between the two peers — real, but distinct from an application-level E2EE guarantee tied
to Inaya's own identity/key system (SOW §11.3). Because v1 has no SFU at all, there is no third party in the media path to worry about
for confidentiality; the meeting's security banner (§7.21) reflects this plainly: `Encrypted` (transport) vs `Hybrid PQC`/`PQC Required`
(key-establishment mode, once the PQC layer gates meeting key exchange — see `docs/architecture/pqc-architecture-adr.md`).

## 5. Meeting key establishment

Meeting room creation generates a room secret locally on the host's device; it is wrapped to each admitted participant's device key
using the same hybrid envelope format the PQC layer defines (classical-only, hybrid, or PQC-required, per org policy) — not a new
envelope format invented for Meet. The room secret never appears in the join URL or in signaling payloads; only wrapped envelopes and
non-secret metadata do (§7.10, §11.1).

## 6. Chat reuse

In-call chat is Secure Chat's existing conversation model with an ephemeral `kind` value, not a second message system — see
`src/lib/chat/conversations.js` and `docs/internxt-feature-reuse-matrix.md`. Default retention: `EPHEMERAL` — ciphertext may be deleted
at meeting end, server-side plaintext never exists, no searchable permanent copy is created by default.

## 7. Out of scope for v1 (explicit, per SOW §7.26-28, §19.20-22)

Recording, transcription, and AI analysis of meeting content are not built. A future SFU, if a real customer need for larger rooms
emerges, is the documented next step and requires its own infrastructure decision — standing up a dedicated always-on media server, or
adopting a third-party WebRTC SaaS with frame-level E2EE (Insertable Streams) so the third party never receives reusable plaintext media
keys. That decision is explicitly **not** made by this ADR; it is deferred to whenever room-size demand actually justifies it.

## 8. Rejected alternatives

* **Self-hosted SFU now (mediasoup/LiveKit OSS).** Rejected for v1: requires new always-on infrastructure, contradicting the project's
  current Vercel-only deployment decision, for a scale requirement not yet demonstrated.
* **Third-party WebRTC SaaS now (LiveKit Cloud/Daily/Twilio/Agora).** Rejected for v1: real ongoing cost and a new third-party data-path
  decision, deferred until mesh's real limit is actually hit by real usage.
* **WebSocket signaling server.** Rejected: the same Vercel-persistent-connection constraint that shaped Secure Chat's own transport
  applies identically here; no reason to introduce a second real-time transport pattern alongside the one already proven.
