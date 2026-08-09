// src/lib/ai-business-tools.js
//
// Tool implementations for the AI Business Assistant (POST /api/ai/business-chat).
//
// THE HARD RULE: the assistant must never reveal anything the requesting
// user couldn't already see through the normal UI. This file is where
// that's enforced — not in the prompt, not as an instruction the model is
// asked to follow. Every tool here operates over `scope`, the result of
// getAccessibleScope() (document-permissions.js) computed ONCE per chat
// request from the caller's real org membership — the exact same
// department/project/document visibility resolution every other route in
// this app already uses. A document the caller can't see was never in
// `scope.visibleDocuments` to begin with, so no filename/department/
// project lookup here can ever surface it, no matter what the model asks
// for. "Who has access to this document" goes one step further and
// re-checks MANAGE-level access at call time via requireDocumentAccess()
// (the same gate the Permissions panel's API route uses) — VIEW/EDIT
// visibility is not enough to see the full grant list, so the tool
// returns a permissionDenied result instead of the data when that's the
// case, and the assistant must relay that rather than paraphrase around it.
//
// If a prompt-injection attempt (in a filename, a chat message, anything)
// tries to get the model to ask for something outside `scope`, the lookup
// just returns "not found" — there is no path from "the model asked" to
// "the database returned it" that skips permission resolution.

import { Type } from "@google/genai";
import { getOrgCollections } from "./orgs.js";
import { getAccessibleScope, requireDocumentAccess } from "./document-permissions.js";

const ALLOWED_STATUSES = ["DRAFT", "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "ARCHIVED"];

/** Computed once per chat request and threaded into every tool call. */
export async function buildBusinessContext({ orgId, membership, email }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const deptNameById = new Map(scope.visibleDepartments.map((d) => [d._id.toString(), d.name]));
  const projNameById = new Map(scope.visibleProjects.map((p) => [p._id.toString(), p.name]));
  const projDeptById = new Map(scope.visibleProjects.map((p) => [p._id.toString(), p.departmentId.toString()]));
  return { orgId, membership, email, scope, deptNameById, projNameById, projDeptById };
}

function matchesName(actualName, wanted) {
  if (!wanted) return true;
  return (actualName || "").toLowerCase().includes(wanted.toLowerCase());
}

function docSummary(doc, ctx) {
  return {
    filename: doc.filename,
    status: doc.status,
    accessLevel: doc.accessLevel || "DEPARTMENT",
    departmentName: ctx.deptNameById.get(doc.departmentId.toString()) || "Unknown",
    projectName: ctx.projNameById.get(doc.projectId.toString()) || "Unknown",
    uploadedByEmail: doc.uploadedByEmail,
    createdAt: doc.createdAt,
  };
}

// ============================================================
// Tool implementations — every one reads only from ctx.scope (or, for
// get_document_access, re-verifies MANAGE at call time).
// ============================================================
function listDocuments(args, ctx) {
  const { status, departmentName, projectName, filenameContains, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => ALLOWED_STATUSES.includes(s)) : null;

  const results = ctx.scope.visibleDocuments
    .filter((doc) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(doc.status)) return false;
      if (!matchesName(ctx.deptNameById.get(doc.departmentId.toString()), departmentName)) return false;
      if (!matchesName(ctx.projNameById.get(doc.projectId.toString()), projectName)) return false;
      if (filenameContains && !doc.filename.toLowerCase().includes(filenameContains.toLowerCase())) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((doc) => docSummary(doc, ctx));

  return { count: results.length, documents: results };
}

function listDepartments(_args, ctx) {
  const projectCountByDept = new Map();
  const docCountByDept = new Map();
  for (const p of ctx.scope.visibleProjects) {
    const key = p.departmentId.toString();
    projectCountByDept.set(key, (projectCountByDept.get(key) || 0) + 1);
  }
  for (const d of ctx.scope.visibleDocuments) {
    const key = d.departmentId.toString();
    docCountByDept.set(key, (docCountByDept.get(key) || 0) + 1);
  }
  return {
    departments: ctx.scope.visibleDepartments.map((d) => ({
      name: d.name,
      projectCount: projectCountByDept.get(d._id.toString()) || 0,
      documentCount: docCountByDept.get(d._id.toString()) || 0,
    })),
  };
}

function listProjects(args, ctx) {
  const { departmentName, onlyWithPendingDocuments } = args || {};
  const pendingProjectIds = new Set(
    ctx.scope.visibleDocuments
      .filter((d) => d.status === "PENDING" || d.status === "UNDER_REVIEW")
      .map((d) => d.projectId.toString())
  );
  const docCountByProject = new Map();
  for (const d of ctx.scope.visibleDocuments) {
    const key = d.projectId.toString();
    docCountByProject.set(key, (docCountByProject.get(key) || 0) + 1);
  }

  const results = ctx.scope.visibleProjects
    .filter((p) => matchesName(ctx.deptNameById.get(p.departmentId.toString()), departmentName))
    .filter((p) => !onlyWithPendingDocuments || pendingProjectIds.has(p._id.toString()))
    .map((p) => ({
      name: p.name,
      departmentName: ctx.deptNameById.get(p.departmentId.toString()) || "Unknown",
      documentCount: docCountByProject.get(p._id.toString()) || 0,
      hasPendingDocuments: pendingProjectIds.has(p._id.toString()),
    }));

  return { count: results.length, projects: results };
}

async function getActivity(args, ctx) {
  const { departmentName, projectName, sinceDays, limit } = args || {};
  const cutoff = Date.now() - Math.min(Math.max(sinceDays || 7, 1), 90) * 24 * 60 * 60 * 1000;

  const targetDocIds = ctx.scope.visibleDocuments
    .filter((doc) => matchesName(ctx.deptNameById.get(doc.departmentId.toString()), departmentName))
    .filter((doc) => matchesName(ctx.projNameById.get(doc.projectId.toString()), projectName))
    .map((doc) => doc._id);

  if (targetDocIds.length === 0) return { count: 0, activity: [] };

  const filenameById = new Map(ctx.scope.visibleDocuments.map((d) => [d._id.toString(), d.filename]));
  const { documentActivity } = await getOrgCollections();
  const events = await documentActivity
    .find({ documentId: { $in: targetDocIds } })
    .sort({ timestamp: -1 })
    .limit(Math.min(Math.max(limit || 15, 1), 30))
    .toArray();

  const recent = events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  return {
    count: recent.length,
    activity: recent.map((e) => ({
      filename: filenameById.get(e.documentId.toString()) || "Unknown document",
      action: e.action,
      previousState: e.previousState,
      newState: e.newState,
      actorId: e.actorId,
      timestamp: e.timestamp,
    })),
  };
}

async function getDocumentAccess(args, ctx) {
  const { filename, departmentName, projectName } = args || {};
  if (!filename) return { error: "A filename is required." };

  const candidates = ctx.scope.visibleDocuments
    .filter((doc) => doc.filename.toLowerCase().includes(filename.toLowerCase()))
    .filter((doc) => matchesName(ctx.deptNameById.get(doc.departmentId.toString()), departmentName))
    .filter((doc) => matchesName(ctx.projNameById.get(doc.projectId.toString()), projectName));

  if (candidates.length === 0) {
    // Deliberately vague — this must read identically whether the document
    // doesn't exist or the caller simply can't see it. Confirming "it
    // exists but you can't see it" would itself leak information.
    return { notFound: true, filename };
  }
  if (candidates.length > 1) {
    return {
      ambiguous: true,
      matches: candidates.slice(0, 5).map((doc) => docSummary(doc, ctx)),
    };
  }

  const doc = candidates[0];
  const access = await requireDocumentAccess({
    orgId: ctx.orgId,
    documentId: doc._id,
    membership: ctx.membership,
    email: ctx.email,
    minLevel: "MANAGE",
  });
  if (access.error) {
    return { permissionDenied: true, filename: doc.filename };
  }

  const { documentPermissions } = await getOrgCollections();
  const grants = await documentPermissions.find({ orgId: doc.orgId, documentId: doc._id }).toArray();

  return {
    filename: doc.filename,
    owner: doc.uploadedByEmail,
    grants: grants.map((g) => ({ email: g.email, level: g.level })),
  };
}

// ============================================================
// Gemini function-calling declarations + dispatcher
// ============================================================
export const BUSINESS_TOOL_DECLARATIONS = [
  {
    name: "list_documents",
    description: "List documents the caller can see, optionally filtered by status, department, project, or filename.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: ALLOWED_STATUSES }, description: "Filter to these workflow statuses." },
        departmentName: { type: Type.STRING, description: "Filter to documents in a department whose name contains this text." },
        projectName: { type: Type.STRING, description: "Filter to documents in a project whose name contains this text." },
        filenameContains: { type: Type.STRING, description: "Filter to filenames containing this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_departments",
    description: "List every department the caller can see, with project and document counts.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_projects",
    description: "List projects the caller can see, optionally filtered to a department or to only projects with pending/under-review documents.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        onlyWithPendingDocuments: { type: Type.BOOLEAN, description: "If true, only include projects that currently have a PENDING or UNDER_REVIEW document." },
      },
    },
  },
  {
    name: "get_activity",
    description: "Get recent document activity (submissions, approvals, rejections, shares, etc.), optionally scoped to a department or project and a time window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        projectName: { type: Type.STRING, description: "Filter to a project whose name contains this text." },
        sinceDays: { type: Type.INTEGER, description: "How many days back to look, default 7, max 90." },
        limit: { type: Type.INTEGER, description: "Max results, default 15, max 30." },
      },
    },
  },
  {
    name: "get_document_access",
    description: "Get who has access to a specific document by filename (or partial filename). Only succeeds if the caller has MANAGE-level access to that document — otherwise returns permissionDenied.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: "The document's filename, or a distinctive part of it." },
        departmentName: { type: Type.STRING, description: "Optional — narrow down if multiple documents share a similar name." },
        projectName: { type: Type.STRING, description: "Optional — narrow down if multiple documents share a similar name." },
      },
      required: ["filename"],
    },
  },
];

const TOOL_IMPLEMENTATIONS = {
  list_documents: listDocuments,
  list_departments: listDepartments,
  list_projects: listProjects,
  get_activity: getActivity,
  get_document_access: getDocumentAccess,
};

export async function runBusinessTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function businessSystemInstruction({ orgName, role, isManager }) {
  return `You are the Inaya AI Business Assistant, embedded in the "${orgName}" company's Business Workspace. The person you're talking to signed in as ${role}${isManager ? " (has manage/approval authority)" : " (standard member)"}.

You answer questions about this company's departments, projects, documents, workflow status, and activity by calling the provided tools — never guess or invent data. Every tool is already scoped to exactly what this person is allowed to see; if a tool returns notFound or an empty list, that's the honest answer (either it doesn't exist or they don't have access to it) — do not speculate about which.

If get_document_access returns permissionDenied, tell the user plainly that they don't have permission to view who has access to that document (only the document's owner, an explicit MANAGE grant, or a company owner/admin can see that) — do not attempt to answer the question any other way, and do not reveal the document's owner or any grant information in that case.

Keep answers concise and concrete: reference actual filenames, department/project names, statuses, and dates from the tool results. Use plain language, not raw JSON. If a request is ambiguous (e.g. multiple documents match a name), ask a short clarifying question or list the candidates the tool returned.

You cannot take actions (approve, reject, upload, share, change permissions) — you only look things up and summarize. If asked to perform an action, explain that they should use the workspace UI for that.`;
}
