# Threat model: Inaya Meet

Companion to `docs/architecture/meet-architecture-adr.md`. Status: 2026-10-07, pre-implementation.

## Assets

1. Meeting media (audio/video/screen-share) confidentiality. 2. In-call chat (reused Secure Chat ciphertext). 3. Room admission
integrity (who can join, who is moderator). 4. Meeting metadata and audit trail. 5. Join-link/token unguessability.

## Actors

Same base set as `docs/security/e2ee-chat-threat-model.md`, plus: **uninvited internet user** who discovers or guesses a room ID/link;
**revoked/removed participant** attempting to continue receiving media or rejoin; **guest** (no Inaya account) attempting to exceed
guest-policy bounds.

## Threats and mitigations

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Room ID/join-link guessing | Links are unguessable (cryptographically random), rate-limited, and — where policy calls for a one-time admission token — single-use | adversarial: room-ID guessing, reused token |
| T2 | Join link theft/forwarding | Links are short-lived where policy allows and bound to the specific `meetingId`; a signed one-time admission token cannot be replayed after first use | expired-link, reused-token tests |
| T3 | Moderator spoofing: browser claims `isModerator: true` | Moderator authorization is checked server-side against the stored room/participant record, never trusted from client state | forged-moderator-request test |
| T4 | Cross-org room access | Room access check includes room organization + membership/guest-admission state; fails closed on mismatch | cross-org isolation test |
| T5 | Removed participant continues receiving media | Mesh has no server media relay to cut off centrally, so removal must also tear down each remaining peer's `RTCPeerConnection` to the removed participant client-side, triggered by the same signaling channel that delivered the removal event | removed-participant media-stop test |
| T6 | Revoked participant rejoins | Room/participant state marks them revoked; a new join attempt against that room/identity is rejected at the API layer, not just hidden in the UI | revoked-rejoin test |
| T7 | Meeting key leakage via URL or logs | Room secret and wrapped envelopes never appear in the join URL or in signaling-layer logs; only non-secret metadata (meetingId, ephemeral session IDs) does | URL/log-scan test |
| T8 | Guest impersonation (claims to be an invited email without proof) | Guest admission policy supports named-invite-only, one-time-code, or open-with-approval modes; the chosen mode is enforced server-side, not left to client claim | guest-authorization-bypass test |
| T9 | PQC downgrade in `PQC_REQUIRED` meetings | Same downgrade-rejection mechanism as the PQC layer itself (`docs/security/pqc-threat-model.md` T2) — a classical-only client cannot join a `PQC_REQUIRED` room | PQC-downgrade test |
| T10 | Network eavesdropper on signaling | Signaling travels over the existing authenticated/TLS API surface; it carries no media or plaintext content, only SDP/ICE/control events | — (inherits existing API TLS posture) |
| T11 | Network eavesdropper on media (no SFU in v1) | WebRTC DTLS-SRTP provides transport encryption for the direct peer-to-peer media path; see ADR §4 for the honest distinction between this and an application-level E2EE key guarantee | — (standard WebRTC transport security, verified by browser compliance, not re-tested here) |

## Explicitly out of scope for v1 (per the ADR)

An SFU's own compromise/visibility threats do not apply, because v1 has no SFU. Recording/transcription threats (unauthorized capture,
AI analysis of content) do not apply, because neither feature is built.
