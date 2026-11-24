# Why Inaya Business OS: Verification Report and Release Notes

Date: 24 Nov 2026 · Environment: local production build (`next build`, `.next-prod`) on the test database, with real Gemini and Groq services. **Not deployed to production** (SOW release gate: owner sign-off first).

## Routes and files

| Added | Purpose |
|---|---|
| `/business/why-inaya` (`src/app/business/why-inaya/page.js`, `WhyInayaClient.js`) | Dedicated page: intro, differentiators, connected-platform model, comparison, value, team, next steps |
| `/api/why-inaya/explain` | Public, consent-gated explainer (rate limit 8/hour per hashed IP, 8 KB body cap, no storage of answers) |
| `/api/why-inaya/tts` | Gemini narration, one scene per call; only speaks server-signed scene text (HMAC, 30 min); 40/hour per hashed IP |
| `src/components/whyInaya/Explainer.js`, `AvatarStage.js` | Consent dialog, questions, canvas avatar stage (presenter or orb), controls, transcript, WebM download |
| `src/lib/whyInaya/content.js`, `competitors.js`, `savings.js`, `script.js`, `pricing.server.js`, `explainer.server.js` | Claims register, competitor register, deterministic arithmetic, narration builder, server AI |
| `scripts/why-inaya/hero-regression.mjs` | Hero screenshot + HTML comparison |

| Changed | Change |
|---|---|
| `BusinessClient.js` | Top row only: "Why Inaya Business OS? →" link beside "← Inaya Network" (outside the hero) |
| `sitemap.js` | Adds `/business/why-inaya` |
| `metrics.js` | 3 privacy-safe counters (`why_inaya.explain`, `why_inaya.tts`, `why_inaya.rate_limited`) |
| Order blocks (owner-approved pricing) | `commercePricing.js`, `online/stores.js`, `online/channels.js`, admin licenses route and page, `OnlineStoreView.js`, pricing page, SaaS business model, roadmap stage, user guide, online guide |

No changes to the hero, authentication, billing logic, licence states, Commerce/POS/accounting logic, the dApp or storage.

## Results

| Check | Result |
|---|---|
| Hero regression (desktop 1440, tablet 834, phone 390) vs live production | **Identical**: HTML hash `b6e9b054c1e4`, text, size and position (evidence: `evidence/hero-baseline-live`, `evidence/hero-after-local`) |
| Production build | Passes |
| UI tests (`jest test-ui`) | 163/163 |
| Explainer tests (`why-inaya-savings`, `why-inaya-script`) | 17/17: no-cost, one and many tools, negative difference, PKR/USD, branches, connected stores, order blocks, Enterprise switch, time cost, hypothetical, invalid/extreme/blank input, rounding, AI validation (digits, money, links, guarantees, "real-time", unknown capabilities), injection, malformed AI output, signed tokens, expiry, tampering |
| Order blocks (`commerce-order-blocks*`) | 14/14 incl. admin API route: auth, confirm, reason, cap, eligibility, concurrent double click |
| Licence suites | 33/33 |
| Online commerce suite | passes with blocks (12/12 with the DB test) |
| Live AI wording (Gemini) | Works; one retry on 503; Groq fallback; template fallback when both fail |
| Prompt injection in answers | Ignored; free text never reaches the narration (fixed lists only) |
| Avatar + Gemini voice in the browser | Plays scene by scene; first sound ~10 s after Play; no gaps between scenes; mouth/orb driven by the audio; captions; workflow step highlighted as spoken |
| Pause / resume / stop / replay, presenter/orb switch | Pass |
| Decline ("Not now", Escape) | Closes; no API calls; focus kept in the dialog while open |
| Phone layout (375 px) | No horizontal scroll; comparison table becomes cards |
| Gemini voice quota exhausted | Falls back to the device voice from the current scene, with a message; transcript always shown |
| No autoplay | Audio only after Play |

## Open items for the owner

1. **Gemini voice quota.** The free tier ran out after about 15 scene generations today, which is about 2 walkthroughs a day. For real visitors, enable paid billing on the Gemini key. At Google's published TTS rate this is roughly US$0.04 per full walkthrough (please confirm in AI Studio). Until then visitors get the device voice; everything else works.
2. **Video download** could not be checked end to end today because it needs the AI voice (quota). Re-test after the quota resets or billing is on.
3. **Live non-production acceptance** (SOW 11.6) needs a Vercel preview deployment, then production only after sign-off.
