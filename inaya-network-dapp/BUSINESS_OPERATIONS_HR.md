# Business Operations — Phase 5b: HR

**Built:** August 26, 2026. Half of the "Inaya Finance & HR Layer" SOW — Employee records, HR documents, Leave management, and Department Administration. A **testnet demonstration/validation layer** (see BUSINESS_OPERATIONS_FINANCE.md's header note — same scope framing applies here); every HR screen carries the same "Testnet / Beta" badge.

## Where it lives

- **Schema + indexes:** `src/lib/orgs.js` (`employees`, `leaveRequests`, `attachments`)
- **Roles:** `canManageHR()` / `canAccessHR()` / `isDepartmentManager()` / `isSelfEmployeeRecord()` in `src/lib/orgs.js` — additive `hrRole: null | "manager" | "staff"` and `managedDepartmentIds: [ObjectId]` fields on `org_members`
- **Workflows:** `src/lib/employee-workflow.js` (`transitionEmployee()`), `src/lib/leave-workflow.js` (`transitionLeaveRequest()`, `getLeaveBalance()`)
- **Attachments:** `src/lib/attachments.js` — shared with Finance, `relatedRecordType: "EMPLOYEE"` for HR documents
- **API:** `src/app/api/orgs/hr/employees/**` (incl. `[employeeId]/attachments`, `[employeeId]/leave-balance`), `.../leave-requests/**`, `.../departments/[departmentId]/manager/route.js`
- **Dashboard:** `hrSummary` field in `src/app/api/orgs/dashboard/route.js`
- **AI tools:** `list_employees`, `find_employee_document` in `src/lib/ai-business-tools.js`
- **Web UI:** `src/components/business/HRView.js` (Employees / Leave / Department Managers tabs)
- **Mobile UI:** `inaya-mobile/src/screens/business/HRScreen.js` + `EmployeeDetailScreen.js`
- **Tests:** `test/hr-workflow.test.mjs`

## Data model

```
employees        _id, orgId, departmentId, memberEmail (nullable, FK org_members), fullName, jobTitle,
                  employmentStatus (ONBOARDING|ACTIVE|ON_LEAVE|TERMINATED), joiningDate, contactEmail,
                  contactPhone, annualLeaveAllocationDays (default 20), createdByEmail, createdAt, updatedAt, deletedAt

leave_requests    _id, orgId, employeeId, leaveType, startDate, endDate, reason,
                  status (PENDING|APPROVED|REJECTED|CANCELLED), approvedByEmail, createdAt, updatedAt
```

`memberEmail` is deliberately **nullable** — an employee with workspace access has it set (linking to their real `org_members` doc, satisfying the SOW's "share existing workspace identity... rather than creating separate user accounts"); an employee HR tracks who never logs in is still a valid record.

## The "Employee" role isn't a role string

The SOW's 7th permission role ("Employee — personal HR information and permitted documents") is not a new value in any role enum. It's a data-scoping rule: any active member viewing an `employees` record whose `memberEmail` matches their own session email gets read access to that one record and their own `leave_requests`, regardless of `hrRole`. `isSelfEmployeeRecord()` is the one function that checks this, called from every employee/leave route alongside the HR-role checks.

## Department Manager is new, not reused

Departments had no manager concept before this phase. `managedDepartmentIds` on `org_members` (set via `POST/DELETE /api/orgs/hr/departments/[departmentId]/manager`, org-manager-only) grants read access to employee records in that specific department — without granting org-wide HR visibility. This is additive to the same `org_members` document Finance's `financeRole` and the base `role` field already live on, not a parallel permission system.

## Leave balance is computed, never a mutable counter

`getLeaveBalance()` (`leave-workflow.js`) computes `allocationDays - sum(this year's APPROVED leave request day-spans)` fresh on every read — the same "ledger is truth, a balance is just a cached sum" discipline `inventory.js`'s stock levels and `faucet.js`'s lifetime-cap tracking already established. A mutable stored counter would risk drift (a request approved then later found stale, a manual edit that falls out of sync); recomputing from the real `leave_requests` history never can.

## Workflows

```
employee-workflow.js   activate: ONBOARDING→ACTIVE | placeOnLeave: ACTIVE→ON_LEAVE | returnFromLeave: ON_LEAVE→ACTIVE
                        terminate: ACTIVE|ON_LEAVE→TERMINATED (requiresManage: canManageHR)
leave-workflow.js       approve/reject: PENDING→APPROVED|REJECTED (requiresManage: canManageHR)
                        cancel: PENDING→CANCELLED (the requester's own request, or canManageHR)
```

## Permission model

- **Employees:** `canAccessHR`/`canManageHR` (HR Staff/Manager or org owner/admin) for department-scoped org-wide visibility and edits; a Department Manager gets read-only visibility into their managed department(s); any member always sees their own linked record (self-access is read-only — only HR can edit or delete).
- **Leave requests:** HR roles see everything in their accessible departments; anyone else sees and can create/cancel only their own requests (matched via their linked `employees.memberEmail`).
- **HR documents (attachments):** view gated by `canAccessHR` OR the employee's own `memberEmail` match; upload is HR-only (self-access is view-only, matching the base employee record's read/no-write split).

## `getAccessibleScope()` — a real bug caught by testing

The dashboard/AI aggregate resolver (`document-permissions.js`) originally filtered a Department Manager's `managedDepartmentIds` against their own `visibleDeptIds` before querying — intended to skip redundant queries, but wrong: department-level visibility (via `canAccessDepartment`/`departmentIds`) does **not** imply HR/employee visibility, which is gated separately by `canAccessHR`. A Department Manager whose own membership also includes their managed department (the normal case) ended up with an empty `managedDeptIds` and silently lost their HR grant — caught by `test/hr-workflow.test.mjs`'s Department Manager scope test, fixed by removing the incorrect filter.

## Verified, not just written

- `node --env-file=.env.local --test test/hr-workflow.test.mjs` — 9/9 passing against real Atlas: full employee lifecycle (onboarding→active→on_leave→active→terminated) with the termination manage-gate enforced, a plain member denied every transition, the leave approval gate (HR Staff denied, owner/admin allowed) with `approvedByEmail` correctly recorded, self-cancel of one's own PENDING request (and denial of cancelling someone else's), computed leave balance correctness (only approved THIS-YEAR spans count — rejected and prior-year requests are correctly excluded), self-access visibility across department boundaries, HR Staff org-wide visibility, Department Manager scoped-to-their-department visibility, and a plain member with no HR grant seeing nothing beyond their own record.
- `npm run build` — production build compiles cleanly with the new routes and `HRView.js`.

## Explicitly out of scope (this pass)

- No formal onboarding checklist/document-requirements system — `employmentStatus`'s ONBOARDING state plus free-form document attachments cover "onboarding" without a separate checklist feature the SOW doesn't ask for in detail.
- No payroll processing, tax withholding, or compensation/salary tracking — HR records identity, status, documents, and leave; nothing that touches real compensation.
- No org chart / reporting-line hierarchy beyond department + Department Manager.
