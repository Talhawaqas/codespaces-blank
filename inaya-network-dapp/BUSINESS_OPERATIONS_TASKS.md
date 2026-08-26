# Business Operations — Phase 1: Projects & Tasks

**Built:** August 25, 2026. Phase 1 of the "Inaya Business Operations" SOW (Projects & Tasks, CRM, Procurement, Inventory) — this covers Tasks only. CRM, Procurement, and Inventory are explicitly out of scope for this pass; their schema/roadmap sketch lives in the approved plan, not in shipped code.

## Where it lives

- **Schema + indexes:** `src/lib/orgs.js` (`tasks`, `org_activity` added to `getOrgCollections()`/`ensureOrgIndexes()`)
- **State machine:** `src/lib/task-workflow.js` — `TASK_STATES`, `TRANSITIONS`, `transitionTask()`
- **Audit log:** `src/lib/org-activity-log.js` — `logOrgActivity()`, `listOrgActivityForRecord()` (a new, additive collection — `document_activity` is untouched)
- **API:** `src/app/api/orgs/tasks/route.js`, `.../[taskId]/route.js`, `.../[taskId]/transition/route.js`, `.../[taskId]/activity/route.js`
- **Dashboard:** `src/app/api/orgs/dashboard/route.js` — additive `taskSummary` field
- **AI tool:** `list_tasks` in `src/lib/ai-business-tools.js`
- **Web UI:** `src/components/business/TasksView.js`, wired into `src/app/business/page.js`'s sidebar (new "Tasks" nav item)
- **Mobile UI:** `inaya-mobile/src/screens/business/TasksScreen.js` + `TaskDetailScreen.js`, wired into `BusinessWorkspaceStack.js` and reachable from `OrgHomeScreen.js`
- **Tests:** `test/task-workflow.test.mjs`

## Data model

A task is a child of an existing `projects` record (Projects already shipped in production before this phase — this work does not create a new Project entity):

```
tasks
  _id, orgId, departmentId (denormalized from the project),
  projectId, title, description, status, priority,
  assigneeEmail (nullable), dueDate (nullable), createdByEmail,
  createdAt, updatedAt, completedAt (nullable), deletedAt (nullable, soft delete)
```

`status` is one of `TODO | IN_PROGRESS | BLOCKED | DONE | CANCELLED`. `priority` is one of `LOW | MEDIUM | HIGH | URGENT`.

## Permission model

Every transition and every task list/detail query is gated by `canAccessDepartment(membership, task.departmentId)` — the same department-level access check every other Business Workspace record uses. There is no per-assignee gate and no `requiresManage` transition: tasks are collaborative work items, not approvals, so anyone with department access can move any task in that department through the state machine, not just its assignee. Editing a task's own fields (title/description/priority/assignee/dueDate) or deleting it is further restricted to the task's creator, its current assignee, or an owner/admin — that's a field-level rule enforced in `[taskId]/route.js`, separate from the state-transition rule in `task-workflow.js`.

## State machine

```
start:    TODO -> IN_PROGRESS
block:    IN_PROGRESS -> BLOCKED
resume:   BLOCKED -> IN_PROGRESS
complete: IN_PROGRESS -> DONE          (sets completedAt)
reopen:   DONE -> IN_PROGRESS          (clears completedAt)
cancel:   TODO | IN_PROGRESS | BLOCKED -> CANCELLED
```

Every transition is one atomic `findOneAndUpdate({_id, orgId, status: from}, {$set: {status: to}})` — the same pattern `document-workflow.js` uses. A mismatched current status (someone else already moved it, or this is a replayed request) yields a clean 409 with no extra locking machinery, verified under real concurrent requests in the test suite.

## AI integration

`list_tasks` is a new Gemini function-calling tool in `src/lib/ai-business-tools.js`, following the same structural-enforcement pattern as the existing 5 tools: it only ever reads from `ctx.scope.visibleTasks`, itself computed once per chat request from the caller's real department access via `getAccessibleScope()`. There is no prompt-level instruction keeping the assistant "in scope" — a task in a department the caller can't access was never in the scoped object to begin with, so no phrasing of the question can surface it. This makes "Show my overdue tasks," "What's assigned to me," and similar questions answerable on day one, verified in the test suite by asserting a task in an inaccessible department never appears in `list_tasks` results regardless of the filter asked for.

## Honesty behavior

The dashboard's `taskSummary` (`totalOpen`, `overdueCount`, `dueSoonCount`, `byStatus`) is computed directly from the caller's real `visibleTasks` — no placeholder counts, no fabricated "due soon" window beyond the documented 3-day threshold used in the computation.

## Verified, not just written

- `node --env-file=.env.local --test test/task-workflow.test.mjs` — 16/16 tests pass against the real database: every valid transition, invalid transitions rejected with no state change, department-outside members denied every transition, a non-assignee department member succeeds anyway, cross-org task IDs 404, replayed and concurrent transition requests both resolve to exactly one winner with exactly one activity entry, `org_activity` entries have the correct shape/action/ordering, `visibleTasks` is correctly department-scoped (including the owner/admin org-wide case), and `list_tasks` correctly filters `overdueOnly` while never leaking a task from an inaccessible department.
- `npm run build` — the new API routes and `TasksView` component compile cleanly in a real production build.
- `/business` loaded in a live dev server with `TasksView` wired into the sidebar; the page renders without errors introduced by this work.

## Explicitly out of scope (this pass)

- CRM, Procurement, Inventory — schema and design recorded in the approved plan, not built.
- No record-level task permissions beyond department access (no per-task grant table, matching the plan's explicit Phase 1 scoping decision).
- No recurring tasks, subtasks, or task dependencies.
- No push notifications for assignment or due dates.
