# Why Inaya Business OS — Phase 0 Audit (Batch 0)

SOW: `Inaya_Business_OS_Differentiators_Competitive_Intelligence_AI_Explainer_SOW.md` (24 Nov 2026)
Audit date: 24 Nov 2026 · Repo HEAD: 7e6ea26 · No production-facing changes made.

## 1. Website and navigation

| Item | Finding | Implication |
|---|---|---|
| Landing route | `/business` → `src/app/business/page.js` → `BusinessClient.js` (landing branch ~line 629–700) | Hero = lines 660–699. **Frozen.** |
| Header / nav | The landing has **no menu bar**: only "← Inaya Network" above the hero, then the hero CTAs (Create a company, Sign in, Watch the demo, See pricing). | The "Why Inaya" link goes in that top row, beside "← Inaya Network", **outside the hero block**, on desktop and mobile. |
| Other business routes | `/business/pricing`, `/business/demo`, `/business/download`, `/business/roadmap` | Recommended route: **`/business/why-inaya`**. `/about` is the dApp's page and is off-limits. |
| Theme | CSS tokens `--inaya-bg`, `--inaya-surface`, `--inaya-accent`, `--inaya-text-primary/muted`, `--inaya-border`; Tailwind; gold `#b8862f`; `inaya-fade-in-up` animation | Reuse as-is. |
| SEO | `src/app/sitemap.js` (static list), per-route `metadata` with `alternates.canonical`, JSON-LD in `business/layout.js` | Add the route to the sitemap, plus its own metadata. |
| Analytics | `src/app/layout.js` analytics; no event taxonomy for marketing pages | Fire the SOW event names with no free-text or numeric properties. |
| Conversion paths | Create a company / sign in (`/business#workspace-signin`), `ActivationRequestModal`, pricing, demo, user guide PDF | Link to them; don't change them. |

## 2. Existing AI, voice and media

| Capability | Where | Reuse |
|---|---|---|
| LLM | Gemini (`@google/genai`, `GEMINI_API_KEY` server-side), Groq fallback (`groqFallback.js`), AI security gateway (`aiSecurity/gateway.js`) | Explainer text uses Gemini through a **public, tenant-free** route with a strict JSON schema, Groq fallback, and rate limiting (`checkRateLimit`). |
| Voice | Gemini Live voice assistant (`ai-voice-session.js`, in-app, signed-in only); browser `speechSynthesis` in `GuideHintBubble.js` | Not reusable for a public narrated avatar (it is scoped to signed-in tenants). See section 7. |
| Video | Two YouTube demos (Commerce RAvo3aBexHA, Ransomware MEpudvUaxyo); 36-page user guide PDF | Link and embed (lazy-loaded). |

## 3. Commercial truth (canonical code)

| Item | Code value | SOW baseline | Status |
|---|---|---|---|
| Starter | $7.99/mo · PKR 8,000 (`orgPlans.js`, `pkPricing.js`) | not in SOW | **SOW omits the Starter plan** (owner question) |
| Professional | $39 · PKR 20,000 | same | ✓ |
| Business | $99 · PKR 30,000 | same | ✓ |
| Enterprise | $799 · PKR 60,000 | same | ✓ |
| Commerce Starter (Professional add-on) | $49 · PKR 8,000; 1 branch, 1 till, 1 connected store, 300 online orders/mo (`commercePricing.js`) | same | ✓ |
| Commerce add-on (Business) | $79 · PKR 12,000; 2 branches, 3 tills, 1 Shopify + 1 WooCommerce, 1,000 online orders/mo | same | ✓ |
| Business + Commerce bundle | $169 · PKR 40,000 | same | ✓ |
| Enterprise Commerce | included; unlimited branches and tills; 3 connected stores; unlimited orders | same | ✓ |
| Extra branch / till | $19 / $12 · PKR 5,000 / 3,000 | "confirm" | ✓ |
| **Extra 1,000-order block** | **not in code** | SOW says it can be bought | **Discrepancy** (owner question) |
| Annual billing | 10 × monthly | — | ✓ |

Order quota counts **online orders** (web store plus connected stores), not POS sales.

## 4. Team (existing public records)

`src/app/about/page.js` and the JSON-LD in `src/app/layout.js` already publish:
- Talha Waqas — Founder & CTO (bio published)
- Yakub Adnan — Co-Founder & Growth Lead (bio published)
- Fibha Urooj — Chief Financial Officer (bio published; the SOW writes "CFO")

No team photographs exist in `/public`. Plan: typographic cards, one shared `team` source, and the existing bios only if the owner approves reuse.

## 5. Capability and claims register (draft)

| Capability | State | Condition / evidence |
|---|---|---|
| Finance, invoices, expenses, bookkeeping | Live | all paid plans; landing + user guide |
| AI Bookkeeper | Live with conditions | provider/OCR coverage unverified per earlier SOW notes; no general ledger, so claim "bookkeeping assistant", not a GL |
| HR, leave, staff docs, rosters | Live | |
| CRM, appointments, loyalty, gift cards, campaigns | Live | campaigns on Business+ (appointments SOW) |
| Inventory, purchasing, suppliers, multi-location | Live | |
| POS: returns, shifts, cash, receipts | Live with conditions | needs a Commerce entitlement |
| Offline selling | **Beta** | off by default; manager enables it; time, sales and value limits; cash only; server re-check |
| Receipt printers, drawers, labels, camera/phone scanning | **Beta** | pilot customers |
| Native web store | Live with conditions | Commerce entitlement; customer's own Stripe/Safepay |
| Shopify / WooCommerce sync | Live with conditions | connected-store count by plan |
| AI Operations Manager / OS Assistant | Live with conditions | permission-aware; consequential actions need approval |
| Docs Assistant / document intelligence | Live | |
| Client-side document encryption | Live | **documents only**; not every data category |
| Immutable snapshots, ransomware detection, rollback, restore verification | Live | tested (ransomware SOW, demo video); never "guaranteed" |
| S3-compatible storage, Sovereign NAS, Cloud Backup | Live with conditions | plan and storage entitlements |
| Evidence Graph, Digital Twin | Live with conditions | regulated/enterprise editions; low-prominence mention only |
| Audit logs, approvals, roles | Live | |
| **Branch-level user access scoping** | **Not established** | I found per-branch reporting and till/shift/cashier accountability, but **no per-branch user permission scoping** in code. Don't claim "branch-level access controls". |
| Desktop app (Windows) | Live; hardware features Beta | 0.3.2 |
| Android app | Live | |
| Industry editions | Live: General, Health, Legal, Regulated, Financial, Private capital, Government, Education, Hospitality | none planned shown as live |

## 6. Competitor research register (official pages, checked 24 Nov 2026)

The live register is `src/lib/whyInaya/competitors.js`, which is what the page renders. Figures were confirmed from the pages' own price data:

| Competitor | Category | Official price (USD) | Source |
|---|---|---|---|
| Odoo Standard | ERP suite | $11.20 per user per month (monthly) or $8.95 (yearly); first-year discount shown | odoo.com/pricing (monthly/yearly toggle checked in browser) |
| Shopify | E-commerce + POS | Grow $65 monthly / $49 yearly; POS Pro +$89 per location per month, billed yearly | shopify.com/pricing, /pos/pricing |
| Lightspeed Retail | Retail POS | Basic $109 monthly / $89 yearly; Core $179 / $149; Plus $339 / $289 (with Lightspeed Payments) | lightspeedhq.com/pos/retail/pricing (page price data) |
| Zoho POS + Inventory | Separate apps | POS Standard $20 per location monthly / $15 yearly; Inventory Standard $29 per org, billed annually | zoho.com/pos/pricing.html, /inventory/pricing |
| Cin7 Standard | Inventory/OMS | $349/mo (Pro $599, Advanced $1,199); 5 users, 2 integrations, 6,000 sale orders/yr | cin7.com/pricing |

## 7. Owner's change: an AI avatar explainer with video and audio narration

Recommended design, using no new paid service:
- **Avatar:** an original illustrated presenter (SVG/canvas). It is not a real person, and not any team member's face or voice (SOW 5.5). It has idle breathing, blinks, gestures, and lip movement driven live by the narration audio (Web Audio analyser).
- **Video:** the avatar presents beside animated scenes (the visitor's workflow diagram, consolidation and savings figures, limitations), each timed to the narration. The visitor can **download it as a video** (WebM, recorded in the browser), so nothing is stored on our servers.
- **Audio:** Gemini text-to-speech, server-side with the existing key. The browser voice is the fallback, and text-only is the last resort. No autoplay; play, pause, resume, replay and stop; transcript always shown.
- **One result object** feeds the visual, the narration script and the transcript. All arithmetic is deterministic code; the AI writes wording only, validated against a schema.

## 8. Risks and open items for the owner

1. Starter plan: included in the calculator when there's no selling (no Commerce on Starter).
2. Extra 1,000-order block: OWNER DECIDED 24 Nov 2026: $15 / PKR 2,500, monthly recurring or one-month top-up, Commerce Starter + Commerce add-on, max 3. Implemented end to end (pricing, limits, License Manager, pricing page, documents).
3. Team: OWNER DECIDED: names, titles and the /about bios, no photos.
4. Avatar: OWNER DECIDED: both styles (presenter + orb), visitor picks; Gemini voice.
5. Branch-level access: present only as per-branch reporting plus till/shift accountability.
6. Live acceptance environment: a Vercel preview deployment with production-like services; production only after owner sign-off.
