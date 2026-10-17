// app/api/orgs/hr/employees/[employeeId]/onboarding/route.js
//
// GET   ?orgId=...                     -> the employee's onboarding checklist
//        (created from the org template on first view if the employee is
//        ONBOARDING and doesn't have one yet). Readable by the same people
//        who can read the employee record: HR, the employee themself, or
//        their Department Manager.
// POST  { orgId, title }               -> add a one-off item (HR only)
// PATCH { orgId, itemId, done }        -> tick / untick an item (HR only)
// Edits follow the employee-record edit rule: HR roles with access to the
// employee's department.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, isDepartmentManager, isSelfEmployeeRecord, toObjectId } from "../../../../../../../lib/orgs.js";
import { ensureOnboardingChecklist, listOnboardingItems, addOnboardingItem, setOnboardingItemDone } from "../../../../../../../lib/hr-structure.js";

async function load(req, orgId, employeeId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };
  const { employees } = await getOrgCollections();
  const employee = await employees.findOne({ _id: toObjectId(employeeId), orgId: toObjectId(orgId), deletedAt: null });
  if (!employee) return { error: "Employee not found.", status: 404 };
  const hasHR = canAccessHR(auth.membership);
  const canRead = hasHR || isSelfEmployeeRecord(employee, auth.session.email) || isDepartmentManager(auth.membership, employee.departmentId);
  if (!canRead) return { error: "Employee not found.", status: 404 };
  const canEdit = hasHR && canAccessDepartment(auth.membership, employee.departmentId);
  return { auth, employee, canEdit };
}

function progress(items) {
  const done = items.filter((i) => i.done).length;
  return { done, total: items.length, complete: items.length > 0 && done === items.length };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await load(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    await ensureOnboardingChecklist({ orgId, employee: result.employee, actorEmail: result.auth.session.email });
    const items = await listOnboardingItems(orgId, params.employeeId);
    return NextResponse.json({ items, ...progress(items), canEdit: result.canEdit, employmentStatus: result.employee.employmentStatus });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/onboarding GET failed:", err);
    return NextResponse.json({ error: "Could not load the onboarding checklist." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { orgId, title } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await load(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (!result.canEdit) return NextResponse.json({ error: "Only HR can edit the onboarding checklist." }, { status: 403 });
    const added = await addOnboardingItem({ orgId, employeeId: params.employeeId, title, actorEmail: result.auth.session.email });
    if (added.error) return NextResponse.json({ error: added.error }, { status: added.status });
    return NextResponse.json({ items: added.items, ...progress(added.items) });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/onboarding POST failed:", err);
    return NextResponse.json({ error: "Could not add the checklist item." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { orgId, itemId, done } = body;
    if (!orgId || !itemId || typeof done !== "boolean") return NextResponse.json({ error: "orgId, itemId and done (true/false) are required." }, { status: 400 });
    const result = await load(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (!result.canEdit) return NextResponse.json({ error: "Only HR can edit the onboarding checklist." }, { status: 403 });
    const updated = await setOnboardingItemDone({ orgId, employeeId: params.employeeId, itemId, done, actorEmail: result.auth.session.email });
    if (updated.error) return NextResponse.json({ error: updated.error }, { status: updated.status });
    return NextResponse.json({ items: updated.items, ...progress(updated.items) });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/onboarding PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the checklist item." }, { status: 500 });
  }
}
