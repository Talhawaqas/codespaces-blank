// app/api/orgs/tasks/route.js
//
// GET  /api/orgs/tasks?orgId=...&projectId=...&departmentId=...&assigneeEmail=...&status=...&overdue=true&limit=...
//   -> tasks the caller can see. With projectId/departmentId given, scoped
//      to that project/department (canAccessDepartment-gated, same as
//      GET /api/orgs/projects). Without either, falls back to everything
//      visible org-wide via getAccessibleScope()'s visibleTasks, same
//      "full accessible scope" pattern the dashboard/activity routes use.
// POST /api/orgs/tasks  { orgId, projectId, title, description?, priority?, assigneeEmail?, dueDate? }
//   -> create (any member with access to the project's department — team
//      collaboration, not an owner/admin-only action, unlike creating a
//      project itself).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../lib/document-permissions.js";
import { TASK_STATES } from "../../../../lib/task-workflow.js";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

function serializeTask(t, deptNameById, projNameById) {
  return {
    id: t._id.toString(),
    orgId: t.orgId.toString(),
    departmentId: t.departmentId.toString(),
    projectId: t.projectId.toString(),
    departmentName: deptNameById?.get(t.departmentId.toString()) || null,
    projectName: projNameById?.get(t.projectId.toString()) || null,
    title: t.title,
    description: t.description || null,
    status: t.status,
    priority: t.priority,
    assigneeEmail: t.assigneeEmail || null,
    dueDate: t.dueDate || null,
    createdByEmail: t.createdByEmail,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt || null,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const projectId = searchParams.get("projectId");
    const departmentId = searchParams.get("departmentId");
    const assigneeEmail = searchParams.get("assigneeEmail");
    const statusFilter = searchParams.get("status");
    const overdueOnly = searchParams.get("overdue") === "true";
    const limit = Math.min(parseInt(searchParams.get("limit") || "200", 10) || 200, 500);
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    // Always resolve the caller's full accessible scope, once — it's the
    // source of both the "no filter" task list AND the department/project
    // name maps every branch below needs for display (names are safe to
    // attach even on the department/project-filtered paths since they're
    // already drawn from the caller's own visible scope).
    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const deptNameById = new Map(scope.visibleDepartments.map((d) => [d._id.toString(), d.name]));
    const projNameById = new Map(scope.visibleProjects.map((p) => [p._id.toString(), p.name]));

    let list;
    if (projectId || departmentId) {
      const { tasks } = await getOrgCollections();
      const orgObjectId = toObjectId(orgId);
      const query = { orgId: orgObjectId, deletedAt: null };
      if (projectId) query.projectId = toObjectId(projectId);
      if (departmentId) {
        if (!canAccessDepartment(auth.membership, departmentId)) {
          return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
        }
        query.departmentId = toObjectId(departmentId);
      }
      list = await tasks.find(query).sort({ createdAt: -1 }).limit(limit).toArray();
      // projectId alone (no departmentId) doesn't carry an explicit access
      // check above — filter against the caller's real accessible scope so
      // a project ID guess can't leak tasks from a department they can't see.
      if (projectId && !departmentId) {
        const visibleIds = new Set(scope.visibleTasks.map((t) => t._id.toString()));
        list = list.filter((t) => visibleIds.has(t._id.toString()));
      }
    } else {
      list = scope.visibleTasks.slice(0, limit);
    }

    if (statusFilter) {
      const statuses = statusFilter.split(",").map((s) => s.trim().toUpperCase()).filter((s) => TASK_STATES.includes(s));
      if (statuses.length) list = list.filter((t) => statuses.includes(t.status));
    }
    if (assigneeEmail) {
      const normalized = assigneeEmail.trim().toLowerCase();
      list = list.filter((t) => (t.assigneeEmail || "").toLowerCase() === normalized);
    }
    if (overdueOnly) {
      const now = Date.now();
      list = list.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < now && !["DONE", "CANCELLED"].includes(t.status));
    }

    return NextResponse.json({ tasks: list.map((t) => serializeTask(t, deptNameById, projNameById)) });
  } catch (err) {
    console.error("orgs/tasks GET failed:", err);
    return NextResponse.json({ error: "Could not fetch tasks." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, projectId, title: rawTitle, description, priority: rawPriority, assigneeEmail: rawAssignee, dueDate } = await req.json();
    const title = String(rawTitle || "").trim();
    if (!orgId || !projectId) return NextResponse.json({ error: "orgId and projectId are required." }, { status: 400 });
    if (!title) return NextResponse.json({ error: "Task title is required." }, { status: 400 });
    const priority = PRIORITIES.includes(rawPriority) ? rawPriority : "MEDIUM";
    const assigneeEmail = rawAssignee ? String(rawAssignee).trim().toLowerCase() : null;

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { projects, orgMembers, tasks } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const projectObjectId = toObjectId(projectId);

    const project = await projects.findOne({ _id: projectObjectId, orgId: orgObjectId });
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, project.departmentId)) {
      return NextResponse.json({ error: "You don't have access to this project's department." }, { status: 403 });
    }

    if (assigneeEmail) {
      const assigneeMembership = await orgMembers.findOne({ orgId: orgObjectId, email: assigneeEmail, status: "active" });
      if (!assigneeMembership || !canAccessDepartment(assigneeMembership, project.departmentId)) {
        return NextResponse.json({ error: "The assignee must be an active member with access to this project's department." }, { status: 400 });
      }
    }

    const now = new Date().toISOString();
    const result = await tasks.insertOne({
      orgId: orgObjectId,
      departmentId: project.departmentId,
      projectId: projectObjectId,
      title,
      description: description ? String(description).trim() : null,
      status: "TODO",
      priority,
      assigneeEmail,
      dueDate: dueDate || null,
      createdByEmail: auth.session.email,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deletedAt: null,
    });

    return NextResponse.json(serializeTask({
      _id: result.insertedId, orgId: orgObjectId, departmentId: project.departmentId, projectId: projectObjectId,
      title, description, status: "TODO", priority, assigneeEmail, dueDate: dueDate || null,
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now, completedAt: null,
    }));
  } catch (err) {
    console.error("orgs/tasks POST failed:", err);
    return NextResponse.json({ error: "Could not create the task." }, { status: 500 });
  }
}
