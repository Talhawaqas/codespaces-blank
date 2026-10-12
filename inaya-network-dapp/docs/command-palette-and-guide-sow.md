# Command Palette + Virtual Guide (Silent Visual Assistant) — Scope of Work

## Purpose

Corporate users report that Business Workspace is hard to navigate — they bounce between the app and the docs pages often enough that it's costing real time. Two complementary features address the two distinct root causes:

1. **Command Palette** (Cmd/Ctrl+K) — fixes "I can't find the right screen." Instant, keyboard-driven jump to any module or action.
2. **Virtual Guide** (silent visual by default, opt-in voice) — fixes "I don't understand what to do once I'm here." Proactive, zero-typing contextual hints, triggered by detecting the actual back-and-forth behavior users are complaining about.

Explicitly not a chatbot: typing a question is itself part of the friction being solved, so the guide must work with zero typing as the baseline. Voice is a secondary, strictly opt-in layer — not a replacement for the visual guide.

## Context — prior work this builds on

`docs/business-workspace-ux-makeover-report.md` already did a full audit and build pass on this exact surface. Load-bearing facts from it, not to be re-derived:

- `src/app/business/page.js` is the **single client-rendered route** (`/business`) for the whole Workspace — every module is a state-driven view, not a separate route. `VIEW_TITLES` is a `{key: {title, description}}` map; `navigate(key)` switches the active view. This is already the one real registry of "what views exist and how to jump to one."
- A shared design system exists at `src/components/business/ui/`: `Modal.js`, `StatusBadge.js`, `FormField.js`, `RecordRow.js`/`RecordList.js`, `icons.js` (`Icon`/`ICONS`), plus `src/lib/format.js`. Only 2 of ~30 module views (CRM, Tasks) are migrated onto it; the rest work fine on their original (pre-makeover) pattern — irrelevant to this SOW, since both new features only touch top-level navigation/shell state, not individual view internals.
- Jest + React Testing Library are now installed and working (`npm run test:ui`), with 29 passing component tests — reuse this, don't add a second test runner.
- ESLint now actually runs (`npm run lint` was broken before the makeover; fixed as part of it).
- A real-time voice assistant pipeline already exists: Gemini-powered, gated by the org-level `aiPolicy.voiceEnabled` setting (`src/lib/industry-config.js`), implemented via `useVoiceSession.js`. The `Permissions-Policy` header already carves out microphone access specifically for this. This SOW's voice mode reuses this pipeline — it does not build a second one.
- The `?view=` query param is used by the Tauri desktop app's window-popout feature — any navigation change must not break it (the makeover confirmed this via a full grep before removing a view; same care applies here).

## Non-negotiables

1. Reuse the existing design system (`Modal`, `FormField`, `icons`, `RecordRow`, `format.js`) for all new UI — no parallel component set.
2. Reuse `navigate()`/`VIEW_TITLES`/`NAV_ITEMS` in `src/app/business/page.js` as the single source of truth for the palette's index — no second navigation registry to keep in sync.
3. Reuse the existing voice pipeline (`useVoiceSession.js`, `aiPolicy.voiceEnabled`) for the guide's optional voice mode — no second voice/TTS integration.
4. No new route. Stays inside the existing single-route, state-driven shell (preserves the desktop `?view=` popout, matches the prior SOW's own explicit scope decision).
5. Voice defaults OFF and requires two explicit gates: the org's existing `aiPolicy.voiceEnabled`, AND a new, separate per-user guide-voice toggle (enabling voice elsewhere in the product must never silently enable the guide's voice too).
6. The visual guide must be fully usable with zero typing and zero voice — that's the baseline, not a fallback.
7. Keyboard-accessible, proper ARIA labeling on everything new (the prior audit found zero `<label>` usage app-wide before the makeover — don't reintroduce that gap in new code).

## Scope

### Feature 1 — Command Palette

- Cmd/Ctrl+K opens a searchable overlay; fuzzy-matches across every `VIEW_TITLES` entry (all modules, migrated or not).
- Where cheaply available, also indexes common in-module create-actions (e.g. "Create Invoice," "Add Employee") sourced from each view's existing create-button labels — not a hand-maintained separate list that will drift.
- Arrow-key navigation, Enter to jump, Escape/outside-click to close.
- Works identically on migrated and unmigrated views (palette only touches shell-level state).

### Feature 2 — Virtual Guide

- Small, dismissible, non-blocking on-screen indicator — never intercepts clicks on the real UI underneath it.
- "Stuck" detection: concrete, measurable signals (e.g. returning to the same view N times within M seconds, idling on a complex multi-field form without progress) — exact thresholds defined during the Plan phase against real, defensible reasoning, not guessed numbers.
- On trigger: a short, pre-written tip anchored at the relevant element. Pre-written, not live-LLM-generated — zero latency, zero risk of a wrong answer, matches "zero typing" requirement (the user doesn't ask anything, it just appears).
- Content source: a small, new, versioned per-view hint registry — curated by hand initially, not auto-extracted from the existing docs pipeline (keeps this bounded; revisit later if worth connecting).
- Optional voice: only when both gates in Non-negotiable #5 are on; reads the same tip text aloud via the existing voice pipeline, nothing new to maintain.

## Out of scope (explicit, not silently dropped)

- Making the existing Business Workspace AI chat docs-aware (a different idea, discussed and deferred by the user in favor of this one).
- Migrating the remaining ~28 unmigrated module views onto the shared design system (already tracked as remaining work in the prior SOW's report — unrelated to this one).
- Per-module routing/URLs (out of scope in the prior SOW too, for the same desktop-popout reason).
- Any change to auth, permissions, audit logging, or encryption.
- Auto-generating hint content from the docs/content pipeline (starts hand-curated; a future pass if valuable).

## Deliverables

- Command palette component, wired into `src/app/business/page.js`.
- Virtual guide component + stuck-detection logic + initial hint registry (module coverage to be confirmed with the user — defaulting to the modules most likely to generate the reported friction, e.g. Finance, Procurement, HR, Workflows, unless told otherwise).
- Tests via the existing `test:ui` runner for both.
- A short internal doc for future contributors: how to add a new palette entry, how to add a new hint-registry entry.

## Verification

- `npm run build` clean.
- `npm run test:ui` — new tests passing, zero regressions in the existing 29.
- Live browser QA: palette search/navigate across a sample of both migrated and unmigrated modules; guide triggers correctly on a simulated stuck-pattern; voice stays silent unless both gates are explicitly on; `?view=` desktop popout still works.
- Keyboard-only operation of the palette confirmed end to end.
