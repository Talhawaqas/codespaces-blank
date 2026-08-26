// app/api/orgs/dashboard/route.js
//
// GET /api/orgs/dashboard?orgId=...
//
// One aggregate call for the workspace's overview screen — counts plus a
// handful of "recent" items per department/project/document, and a
// pending-approvals list. Everything here is derived from
// getAccessibleScope() (document-permissions.js), so a member only ever
// sees counts/items scoped to what they can actually access; an owner/
// admin sees the whole company because canAccessDepartment/
// getBulkDocumentAccess already bypass every check for them — same
// visibility rules as the existing per-department/per-project routes,
// just aggregated in one place instead of drilled into one level at a time.
//
// Nothing here is fabricated for the UI: department "recent" subtitles are
// a real project count, project cards show a real document count, document
// cards show the real workflow status — no placeholder descriptions or
// invented status fields.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../lib/document-permissions.js";
import { isLowStock } from "../../../../lib/inventory.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const {
      visibleDepartments, visibleProjects, visibleDocuments, visibleTasks,
      visibleContacts, visibleDeals, visibleSuppliers, visiblePurchaseRequests, visiblePurchaseOrders, visibleProducts,
    } = await getAccessibleScope({
      orgId,
      membership: auth.membership,
      email: auth.session.email,
    });

    const projectCountByDept = new Map();
    for (const p of visibleProjects) {
      const key = p.departmentId.toString();
      projectCountByDept.set(key, (projectCountByDept.get(key) || 0) + 1);
    }
    const docCountByProject = new Map();
    for (const d of visibleDocuments) {
      const key = d.projectId.toString();
      docCountByProject.set(key, (docCountByProject.get(key) || 0) + 1);
    }
    const deptNameById = new Map(visibleDepartments.map((d) => [d._id.toString(), d.name]));
    const projNameById = new Map(visibleProjects.map((p) => [p._id.toString(), p.name]));

    const recentDepartments = [...visibleDepartments]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 4)
      .map((d) => ({ id: d._id.toString(), name: d.name, projectCount: projectCountByDept.get(d._id.toString()) || 0 }));

    const recentProjects = [...visibleProjects]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 4)
      .map((p) => ({
        id: p._id.toString(),
        name: p.name,
        departmentId: p.departmentId.toString(),
        departmentName: deptNameById.get(p.departmentId.toString()) || "Unknown",
        documentCount: docCountByProject.get(p._id.toString()) || 0,
      }));

    // visibleDocuments is already createdAt-desc from getAccessibleScope's query.
    const recentDocuments = visibleDocuments.slice(0, 6).map((d) => ({
      id: d._id.toString(),
      filename: d.filename,
      status: d.status,
      accessLevel: d.accessLevel || "DEPARTMENT",
      departmentId: d.departmentId.toString(),
      departmentName: deptNameById.get(d.departmentId.toString()) || "Unknown",
      projectId: d.projectId.toString(),
      projectName: projNameById.get(d.projectId.toString()) || "Unknown",
      createdAt: d.createdAt,
    }));

    const pendingApprovals = visibleDocuments
      .filter((d) => d.status === "PENDING" || d.status === "UNDER_REVIEW")
      .slice(0, 10)
      .map((d) => ({
        id: d._id.toString(),
        filename: d.filename,
        status: d.status,
        departmentId: d.departmentId.toString(),
        departmentName: deptNameById.get(d.departmentId.toString()) || "Unknown",
        projectId: d.projectId.toString(),
        projectName: projNameById.get(d.projectId.toString()) || "Unknown",
      }));

    const now = Date.now();
    const dueSoonMs = 3 * 24 * 60 * 60 * 1000; // 3 days
    const openTasks = visibleTasks.filter((t) => !["DONE", "CANCELLED"].includes(t.status));
    const byStatus = {};
    for (const t of visibleTasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const taskSummary = {
      totalOpen: openTasks.length,
      overdueCount: openTasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < now).length,
      dueSoonCount: openTasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() >= now && new Date(t.dueDate).getTime() < now + dueSoonMs).length,
      byStatus,
    };

    const openDeals = visibleDeals.filter((d) => !["WON", "LOST"].includes(d.status));
    const crmSummary = {
      totalContacts: visibleContacts.length,
      totalLeads: visibleContacts.filter((c) => c.type === "LEAD").length,
      totalCustomers: visibleContacts.filter((c) => c.type === "CUSTOMER").length,
      openDealsCount: openDeals.length,
      openDealsValue: openDeals.reduce((sum, d) => sum + (d.value || 0), 0),
      wonDealsCount: visibleDeals.filter((d) => d.status === "WON").length,
    };

    const procurementSummary = {
      totalSuppliers: visibleSuppliers.length,
      pendingRequestApprovals: visiblePurchaseRequests.filter((r) => r.status === "PENDING_APPROVAL").length,
      pendingOrderApprovals: visiblePurchaseOrders.filter((po) => po.status === "PENDING_APPROVAL").length,
      openOrdersCount: visiblePurchaseOrders.filter((po) => ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)).length,
    };

    let lowStockCount = 0;
    if (visibleProducts.length) {
      const { stockLevels } = await getOrgCollections();
      const productIds = visibleProducts.map((p) => toObjectId(p._id));
      const levels = await stockLevels.find({ orgId: toObjectId(orgId), productId: { $in: productIds } }).toArray();
      const totalByProduct = new Map();
      for (const l of levels) {
        const key = l.productId.toString();
        totalByProduct.set(key, (totalByProduct.get(key) || 0) + l.quantity);
      }
      lowStockCount = visibleProducts.filter((p) => isLowStock(p, totalByProduct.get(p._id.toString()) || 0)).length;
    }
    const inventorySummary = { totalProducts: visibleProducts.length, lowStockCount };

    return NextResponse.json({
      counts: {
        departments: visibleDepartments.length,
        projects: visibleProjects.length,
        documents: visibleDocuments.length,
      },
      recentDepartments,
      recentProjects,
      recentDocuments,
      pendingApprovals,
      taskSummary,
      crmSummary,
      procurementSummary,
      inventorySummary,
    });
  } catch (err) {
    console.error("orgs/dashboard failed:", err);
    return NextResponse.json({ error: "Could not load the dashboard." }, { status: 500 });
  }
}
