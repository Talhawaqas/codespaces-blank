# Business Workspace UX Audit

SOW-required Phase 1 deliverable for the "Inaya Network — Business Workspace Frontend UX/UI Makeover." Produced by inspecting the actual repository (three parallel deep-dives: navigation/shell, page/table/form patterns across all 36 `src/components/business/*.js` files, and shared-component/tooling inventory) before any code was changed.

## 1. Current navigation / route inventory

`NAV_ITEMS` (`src/app/business/page.js:894-934`, 39 entries) drives a single `activeView` state machine rendered from one `<main>` switch (`page.js:1282-1339`) in one client component (`src/app/business/page.js`, ~2,787 lines). There is no per-module Next.js routing — the whole Workspace is one route (`/business`) with client-side state; `?view=` is read once on mount (for the Tauri desktop app's window-popout feature) but never written back to the URL as the user navigates, so there's no back/forward, no bookmarkable per-view URL, during normal use.

Every `NAV_ITEMS` entry resolves to a real render branch; no dead code found. Three real, separate public routes exist alongside it: `/business/pricing`, `/business/roadmap`, `/business/download`, `/business/share/[token]` — none use the Workspace shell.

## 2. What's already solid (not touched by this makeover)

- **Sidebar** (`page.js:1037-1105`): grouped headings, cyan left-border active-item highlight, hand-authored SVG icon system, working mobile drawer (hamburger → dim overlay → slide-in `<aside>` → auto-close on navigate).
- **CommandPalette** (`src/components/CommandPalette.js`): real Cmd/Ctrl+K search, debounced, surface-agnostic.
- **NotificationsBell** (`src/components/NotificationsBell.js`): real polled (60s) notification feed with severity dots and mark-read actions, not a stub.
- **EmptyState** (`src/components/EmptyState.js`): genuinely centralized, imported in 32+ files — the one existing success case of shared UI.
- **Visual language**: wrapper classNames (`space-y-5`, `bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5`), form input styling, and status-badge color vocabulary (green=active/done, amber=pending, red=overdue/rejected, neutral=cancelled) are already near-identical across every file sampled, old and new. No visual drift over the project's timeline.

## 3. Real problems found

### 3.1 Zero component centralization
- `Modal` shell hand-copied **12 times**, byte-identical: `CRMView.js:412`, `TasksView.js:421`, `FinanceView.js:761`, `AttestationsView.js:130`, `HRView.js:470`, `HealthView.js:608`, `FinancialView.js:2314`, `EscrowView.js:225`, `ProcurementView.js:669`, `SignView.js:263`, `LegalView.js:828`, `InventoryView.js:445`.
- Status-badge logic duplicated 6+ times with independent color maps: `TasksView.STATUS_STYLES` (`:35-41`), `CRMView.STAGE_STYLES` (`:29-36`), `ProcurementView.PR_STATUS_STYLES`/`PO_STATUS_STYLES` (`:26-38`), `FinanceView.STATUS_COLORS` (`:33-43`), `HRView.STATUS_COLORS` (`:28-37`), `AIActionRequestsView.STATUS_STYLES` (`:25-33`).
- `formatCurrency`/`formatDate` don't exist — `toLocaleDateString()`/`.toFixed(2)` hand-written **46 times across 19 files** (`FinanceView.js` alone: 16).
- `Icon`/`ICONS` reinvented **3 times**: `page.js:690-885` (the original, large set), `src/components/operator/OperatorSidebar.js:21-29` (its own header comment explains it avoided importing from `page.js` since that file doesn't export them), `src/components/business/tileIcons.js:11-40` (explicitly copy-pasted "verbatim" per its own comment to dodge a circular-import risk).

### 3.2 Real IA confusion
- Two redundant "home" screens: `OsHomeView` (`osHome` key, default landing) and an older inline `DashboardView` (`dashboard` key, `page.js:1388-1554`) — both act as an overview, neither defers to the other.
- Departments/Projects/Documents all rewrite to one `browse` view (`page.js:1162-1166`) with one static header title, `VIEW_TITLES.browse = "Company Records"` — clicking any of the three shows the same generic title.
- "Security" (renders `MfaSettings` — MFA only) vs. "Trust & Resilience" (renders `SecurityResilienceView`) vs. "Recovery Resilience" (renders a *third*, different component, `ResilienceView`) — three adjacent, similarly-named nav items pointing at three different things.
- Zero breadcrumbs anywhere in the codebase (confirmed by grep).
- `OsHomeView.js:215-217` renders its own `<h1>Welcome back — {orgName}</h1>`, independent of and inconsistent with the shell header's `VIEW_TITLES[activeView]` title every other view defers to.

### 3.3 Mobile risk
25 of 36 `src/components/business/*.js` files (69%) have **zero** responsive Tailwind prefixes (`sm:`/`md:`/`lg:`) — including the highest-traffic ones: `FinanceView.js`, `TasksView.js`, `HRView.js`, `ProcurementView.js`, `InventoryView.js`.

### 3.4 Accessibility gap
No `<label>` element exists in any sampled create/edit form — placeholder text doubles as the label everywhere (`CRMView.js`, `HRView.js`, `FinanceView.js`, `ProcurementView.js` all confirmed).

### 3.5 No frontend test tooling
No Jest/Vitest/Testing Library/Playwright/Cypress anywhere in `package.json` or the repo. The existing `test` script runs 108 backend-only `node:test` files against `src/lib`/`src/app/api` — zero frontend coverage exists.

### 3.6 Scale outlier
`FinancialView.js` is 2,326 lines — 3-5x the size of every other view file, and the highest-risk target for any future deep redesign pass.

## 4. Proposed architecture (implemented in this pass)

1. **`src/components/business/ui/`** — new shared design-system components: `icons.js` (centralizes the 3 duplicated Icon/ICONS definitions), `Modal.js` (the 12-times-duplicated shell), `StatusBadge.js` (merges the 6 status-color maps), `FormField.js` (adds real `<label>`s), `RecordRow.js` (the duplicated clickable-row-card pattern).
2. **`src/lib/format.js`** — `formatCurrency`/`formatDate`/`formatDateTime`, replacing the 46 duplicated call sites.
3. **Shell fixes**: `VIEW_TITLES` gains a description slot; `browse` view shows the real clicked section name; the Security/Resilience naming collision is resolved with clearer labels; `DashboardView` is merged into `OsHomeView` (removing the redundant `dashboard` nav entry after confirming nothing else references it).
4. **`OsHomeView.js`** gains a real "Attention Required" section (overdue invoices/low stock/overdue tasks, from the same endpoints their own views already use) and a "Quick Actions" row.
5. **Module migration** (mechanical — swap local duplicated Modal/StatusBadge/formatting for the shared ones, add real `<label>`s, add responsive prefixes where absent) applied to: Documents (`browse`), Tasks, CRM, Procurement, Inventory, Finance, HR, Insights, Settings, Integrations.
6. **Jest + React Testing Library** added via Next's `next/jest` helper, with tests for the new shared components and a smoke test per migrated view.

**Explicitly deferred, not silently dropped** — see the final implementation report for the complete list: `FinancialView.js` (too large for this pass), the remaining ~15 smaller/niche views (Health/Legal/Regulated/Government OS, DataRooms, EnterpriseHardening, Executive, AuditTrail, TrustRelationships, ApiKeys, Attestations, Escrow, Sign, StorageManager, AI Action Requests — all continue working exactly as today, unchanged), and real per-module URL routing (a larger architectural change than a UX/UI makeover, and a risk to the Tauri desktop popout mechanism).
