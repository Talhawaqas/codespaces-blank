# Business Operations — Phase 6: Business Insights & KPI Dashboard

**Built:** August 2026. Executive KPI cards, period-over-period comparison, daily trend charts, and business alerts — a read-only aggregation layer over every module Business Operations already built (Tasks/CRM/Procurement/Inventory, Finance, HR). No new collections, no new writes.

## Where it lives

- **Computation:** `src/lib/business-insights.js` — `computeBusinessInsights({orgId, membership, email, periodDays})`, the one function everything below calls.
- **API:** `GET /api/orgs/insights?orgId=&periodDays=30`
- **AI tool:** `get_business_insights` in `src/lib/ai-business-tools.js` (trends stripped from the AI-facing response — chart data, not something a model needs to reason over token-by-token)
- **Web UI:** `src/components/business/InsightsView.js` (KPI cards, hand-rolled inline-SVG trend charts, alerts with drill-down, period filter)
- **Mobile UI:** `inaya-mobile/src/screens/business/InsightsScreen.js` (KPI cards, comparison, alerts — no charts; see Scope below)
- **Tests:** `test/business-insights.test.mjs`

## Why this required zero new data plumbing

Every KPI, trend, and alert is computed directly from `getAccessibleScope()` — the exact same org-wide, permission-scoped resolver `ai-business-tools.js` and the dashboard aggregate route already call. `computeBusinessInsights()` calls it once and derives everything else in memory: a user's KPI cards, charts, alerts, and AI insights are bounded by precisely what they can already see everywhere else in the workspace (department scope, Finance/HR role gates, Department-Manager scope) — there is no separate, weaker-scoped read path for "insights."

## What's computed

```
KPIs (snapshot, not period-filtered — "headcount" is a right-now number):
  revenue (PAID invoices), expenses (APPROVED expenses), pipelineValue (open deals),
  winRate, taskCompletionRate, overdueTasks, overdueInvoices, lowStockCount,
  headcount (ACTIVE employees), pendingApprovals (documents + PRs + POs + expenses),
  openContacts, activeSuppliers

Trends (daily series over the selected period, zero-filled for empty days):
  revenue, expenses, tasksCompleted, dealsWon

Comparison (current period vs. an equal-length prior period):
  revenue, expenses, dealsWon, tasksCompleted — each with a real changePct

Alerts (most-severe first):
  OVERDUE_INVOICES, LOW_STOCK, OVERDUE_TASKS, PENDING_APPROVALS,
  SIGNIFICANT_KPI_CHANGE (>=20% swing in revenue/expenses/dealsWon/tasksCompleted)
```

## Field-accuracy notes (things that would silently produce wrong numbers if assumed)

- **Tasks are scoped by project, not department directly.** `getAccessibleScope()` resolves `visibleTasks` through real project membership — a department alone isn't enough for a task to be visible. The test suite's own first attempt at a task fixture caught this (a task with no real project row was silently invisible to insights, not a `0` result from a bug — an empty scope), which is exactly the discipline this whole layer depends on.
- **Revenue/expense trend dates use `updatedAt`, not `createdAt`** — `invoice-workflow.js`/`expense-workflow.js` both set `updatedAt` on every transition, so a PAID invoice's `updatedAt` genuinely reflects when it was paid, not when the DRAFT was first created.
- **Deal-won trend/comparison uses `closedAt`**, set by `deal-workflow.js` only on the WON/LOST transition — never `createdAt`, which would date a won deal to when it entered the pipeline instead of when it closed.
- **Low-stock detection reuses the real cross-warehouse stock query** (`stockLevels` grouped by `productId`), the same one-extra-query pattern `list_products`'s AI tool and the Inventory dashboard summary already use — never inferred from `reorderThreshold` being merely set.

## AI integration

`get_business_insights` answers "how's the business doing" / "explain our KPIs" / "what changed this month" questions with the real, permission-scoped aggregate instead of the model chaining several `list_*` tool calls itself and doing its own arithmetic. The system instruction explicitly steers the model to this tool for that class of question.

## Verified, not just written

- `node --env-file=.env.local --test test/business-insights.test.mjs` — 5/5 passing against real Atlas: revenue KPI correctly sums only PAID invoices (ignores DRAFT/SENT/CANCELLED), overdue invoices and low stock both feed their KPI count and produce the matching alert (sorted most-severe first), period-over-period comparison correctly buckets a deal closed 5 days ago vs. one closed 45 days ago into the current vs. prior 30-day window, task completion rate and headcount reflect only real ACTIVE/DONE records, and org isolation — org B's insights never see org A's revenue.
- `npm run build` — production build compiles cleanly with the new route and `InsightsView.js`.

## Explicitly out of scope (this pass)

- **Mobile has no trend charts** — KPI cards, comparison, and alerts only. Charting on mobile is a real UI investment (hand-rolled SVG doesn't translate directly to React Native) better done as a deliberate follow-up than a rushed port; the same "core workflows on mobile, richer visuals on web" split this session already applied to Finance/HR's creation forms and document attachments.
- **No custom date-range picker** — period is a fixed 7/30/90-day selector, not an arbitrary start/end date. Covers the acceptance criteria's "date/period filters" without building a full calendar-range UI for a first pass.
- **No saved/exportable insights snapshots** — every load is computed fresh from live data; there's no "email me last week's KPI summary" or CSV export of the insights themselves (Finance's own CSV reporting already covers the underlying invoice/expense data).
