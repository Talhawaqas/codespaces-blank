// test/hr-workflow.test.mjs
//
// Business Operations Phase 5 (HR) coverage: employee lifecycle, leave
// approval + computed-balance correctness, self-access vs. HR-role access
// boundaries, and department-manager read scope. Same node --test + real
// Atlas + RUN_ID-fixtures convention as every other test file in this repo.
//
// Run with: node --env-file=.env.local --test test/hr-workflow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionEmployee } from "../src/lib/employee-workflow.js";
import { transitionLeaveRequest, getLeaveBalance } from "../src/lib/leave-workflow.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-hr-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], employeeIds: [], leaveRequestIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, employees, leaveRequests, orgActivity } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await employees.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await leaveRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ recordId: { $in: [...cleanup.employeeIds, ...cleanup.leaveRequestIds] } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithHrRoles(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptAResult = await collections.departments.insertOne({ orgId, name: "Engineering", createdAt: now });
  const deptBResult = await collections.departments.insertOne({ orgId, name: "Sales", createdAt: now });

  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  // HR Staff — canAccessHR but NOT canManageHR
  const hrStaffEmail = email(`${label}-hrstaff`);
  await collections.orgMembers.insertOne({ orgId, email: hrStaffEmail, role: "member", departmentIds: [deptAResult.insertedId, deptBResult.insertedId], hrRole: "staff", status: "active", invitedAt: now, joinedAt: now });
  const hrStaff = await collections.orgMembers.findOne({ orgId, email: hrStaffEmail });

  // Plain member with no HR role and no elevated access — will get an employee record linked to them
  const plainEmail = email(`${label}-plain`);
  await collections.orgMembers.insertOne({ orgId, email: plainEmail, role: "member", departmentIds: [deptAResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const plain = await collections.orgMembers.findOne({ orgId, email: plainEmail });

  // Department Manager for deptA only — no hrRole, no org role beyond member
  const deptMgrEmail = email(`${label}-deptmgr`);
  await collections.orgMembers.insertOne({ orgId, email: deptMgrEmail, role: "member", departmentIds: [deptAResult.insertedId], managedDepartmentIds: [deptAResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const deptMgr = await collections.orgMembers.findOne({ orgId, email: deptMgrEmail });

  return {
    orgId, ownerEmail, owner, hrStaffEmail, hrStaff, plainEmail, plain, deptMgrEmail, deptMgr,
    deptAId: deptAResult.insertedId, deptBId: deptBResult.insertedId,
  };
}

async function makeEmployee({ orgId, departmentId, memberEmail = null, employmentStatus = "ONBOARDING", annualLeaveAllocationDays }) {
  const now = new Date().toISOString();
  const doc = {
    orgId, departmentId, memberEmail, fullName: "Test Employee", jobTitle: "Engineer",
    employmentStatus, joiningDate: now, contactEmail: null, contactPhone: null,
    createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, deletedAt: null,
  };
  if (annualLeaveAllocationDays !== undefined) doc.annualLeaveAllocationDays = annualLeaveAllocationDays;
  const result = await collections.employees.insertOne(doc);
  cleanup.employeeIds.push(result.insertedId);
  return result.insertedId;
}

async function makeLeaveRequest({ orgId, employeeId, startDate, endDate, status = "PENDING" }) {
  const now = new Date().toISOString();
  const result = await collections.leaveRequests.insertOne({
    orgId, employeeId, leaveType: "ANNUAL", startDate, endDate, reason: null,
    status, approvedByEmail: null, createdAt: now, updatedAt: now,
  });
  cleanup.leaveRequestIds.push(result.insertedId);
  return result.insertedId;
}

// ============================================================
// Employee lifecycle
// ============================================================
test("employee: full lifecycle onboarding -> active -> on_leave -> active -> terminated", async () => {
  const org = await makeOrgWithHrRoles("employee-lifecycle");
  const employeeId = await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, employmentStatus: "ONBOARDING" });

  const activated = await transitionEmployee({ orgId: org.orgId, employeeId, action: "activate", membership: org.hrStaff, actorEmail: org.hrStaffEmail });
  assert.equal(activated.employee.employmentStatus, "ACTIVE");

  const onLeave = await transitionEmployee({ orgId: org.orgId, employeeId, action: "placeOnLeave", membership: org.hrStaff, actorEmail: org.hrStaffEmail });
  assert.equal(onLeave.employee.employmentStatus, "ON_LEAVE");

  const back = await transitionEmployee({ orgId: org.orgId, employeeId, action: "returnFromLeave", membership: org.hrStaff, actorEmail: org.hrStaffEmail });
  assert.equal(back.employee.employmentStatus, "ACTIVE");

  // termination requires canManageHR — HR Staff must be denied
  const deniedTerminate = await transitionEmployee({ orgId: org.orgId, employeeId, action: "terminate", membership: org.hrStaff, actorEmail: org.hrStaffEmail });
  assert.equal(deniedTerminate.status, 403);

  const terminated = await transitionEmployee({ orgId: org.orgId, employeeId, action: "terminate", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(terminated.employee.employmentStatus, "TERMINATED");
});

test("employee: a plain member with no HR access is denied every transition", async () => {
  const org = await makeOrgWithHrRoles("employee-plain-denied");
  const employeeId = await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, employmentStatus: "ONBOARDING" });
  const result = await transitionEmployee({ orgId: org.orgId, employeeId, action: "activate", membership: org.plain, actorEmail: org.plainEmail });
  assert.equal(result.status, 403);
});

// ============================================================
// Leave approval + computed balance
// ============================================================
test("leave: HR Staff can create/view but only HR Manager (or owner/admin) can approve", async () => {
  const org = await makeOrgWithHrRoles("leave-approval");
  const employeeId = await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, employmentStatus: "ACTIVE" });
  const leaveId = await makeLeaveRequest({ orgId: org.orgId, employeeId, startDate: "2026-09-01", endDate: "2026-09-05" });

  const deniedApprove = await transitionLeaveRequest({ orgId: org.orgId, leaveRequestId: leaveId, action: "approve", membership: org.hrStaff, actorEmail: org.hrStaffEmail });
  assert.equal(deniedApprove.status, 403);

  const approved = await transitionLeaveRequest({ orgId: org.orgId, leaveRequestId: leaveId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(approved.leaveRequest.status, "APPROVED");
  assert.equal(approved.leaveRequest.approvedByEmail, org.ownerEmail);
});

test("leave: an employee can cancel their own PENDING request, but not someone else's", async () => {
  const org = await makeOrgWithHrRoles("leave-self-cancel");
  const employeeId = await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, memberEmail: org.plainEmail, employmentStatus: "ACTIVE" });
  const leaveId = await makeLeaveRequest({ orgId: org.orgId, employeeId, startDate: "2026-10-01", endDate: "2026-10-02" });

  // hrStaff is not the requester and not a manager approving — cancel requires canManageHR OR being the requester
  const deniedCancel = await transitionLeaveRequest({ orgId: org.orgId, leaveRequestId: leaveId, action: "cancel", membership: org.hrStaff, actorEmail: org.hrStaffEmail });
  assert.equal(deniedCancel.status, 403);

  const ownCancel = await transitionLeaveRequest({ orgId: org.orgId, leaveRequestId: leaveId, action: "cancel", membership: org.plain, actorEmail: org.plainEmail });
  assert.equal(ownCancel.leaveRequest.status, "CANCELLED");
});

test("leave: computed balance reflects allocation minus approved this-year day-spans, ignores rejected/cancelled/other-year", async () => {
  const org = await makeOrgWithHrRoles("leave-balance");
  const employeeId = await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, employmentStatus: "ACTIVE", annualLeaveAllocationDays: 20 });

  const currentYear = new Date().getFullYear();
  // Approved 5-day span within this year (Jan 1 inclusive to Jan 5 inclusive = 5 days)
  const approvedLeaveId = await makeLeaveRequest({ orgId: org.orgId, employeeId, startDate: `${currentYear}-01-01`, endDate: `${currentYear}-01-05`, status: "PENDING" });
  await transitionLeaveRequest({ orgId: org.orgId, leaveRequestId: approvedLeaveId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  // A rejected request that should NOT count against the balance
  const rejectedLeaveId = await makeLeaveRequest({ orgId: org.orgId, employeeId, startDate: `${currentYear}-02-01`, endDate: `${currentYear}-02-10`, status: "PENDING" });
  await transitionLeaveRequest({ orgId: org.orgId, leaveRequestId: rejectedLeaveId, action: "reject", membership: org.owner, actorEmail: org.ownerEmail });

  // A prior-year approved request that should NOT count against this year's balance
  await makeLeaveRequest({ orgId: org.orgId, employeeId, startDate: `${currentYear - 1}-06-01`, endDate: `${currentYear - 1}-06-10`, status: "APPROVED" });

  const balance = await getLeaveBalance(org.orgId, employeeId);
  assert.equal(balance.allocationDays, 20);
  assert.equal(balance.usedDays, 5, "only the approved THIS-YEAR span should count");
  assert.equal(balance.remainingDays, 15);
});

// ============================================================
// Self-access vs. HR-role access boundaries (getAccessibleScope)
// ============================================================
test("scope: a plain member always sees their OWN employee record even with no HR access and no matching department", async () => {
  const org = await makeOrgWithHrRoles("scope-self-access");
  // employee record lives in deptB, but plain member's departmentIds only include deptA
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptBId, memberEmail: org.plainEmail, employmentStatus: "ACTIVE" });
  // a decoy employee record for someone else, also in deptB
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptBId, memberEmail: email("someone-else"), employmentStatus: "ACTIVE" });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.plain, email: org.plainEmail });
  const emails = scope.visibleEmployees.map((e) => e.memberEmail);
  assert.ok(emails.includes(org.plainEmail), "the caller's own record must always be visible");
  assert.ok(!emails.includes(email("someone-else")), "a plain member must not see another employee's record via self-access");
});

test("scope: HR Staff sees all employees across departments they can access, not just their own record", async () => {
  const org = await makeOrgWithHrRoles("scope-hr-staff");
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, memberEmail: email("eng-1"), employmentStatus: "ACTIVE" });
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptBId, memberEmail: email("sales-1"), employmentStatus: "ACTIVE" });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.hrStaff, email: org.hrStaffEmail });
  const emails = scope.visibleEmployees.map((e) => e.memberEmail);
  assert.ok(emails.includes(email("eng-1")));
  assert.ok(emails.includes(email("sales-1")));
});

test("scope: Department Manager sees employees in their managed department only, not org-wide HR visibility", async () => {
  const org = await makeOrgWithHrRoles("scope-dept-manager");
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, memberEmail: email("eng-2"), employmentStatus: "ACTIVE" });
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptBId, memberEmail: email("sales-2"), employmentStatus: "ACTIVE" });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.deptMgr, email: org.deptMgrEmail });
  const emails = scope.visibleEmployees.map((e) => e.memberEmail);
  assert.ok(emails.includes(email("eng-2")), "department manager should see employees in their managed department");
  assert.ok(!emails.includes(email("sales-2")), "department manager must not see employees outside their managed department");
});

test("scope: a plain member (no HR role, no dept-manager grant) sees no employees beyond their own record", async () => {
  const org = await makeOrgWithHrRoles("scope-plain-no-hr");
  await makeEmployee({ orgId: org.orgId, departmentId: org.deptAId, memberEmail: email("eng-3"), employmentStatus: "ACTIVE" });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.plain, email: org.plainEmail });
  const emails = scope.visibleEmployees.map((e) => e.memberEmail);
  assert.ok(!emails.includes(email("eng-3")), "a plain member without HR access must not see other employees' records, even in an accessible department");
});
