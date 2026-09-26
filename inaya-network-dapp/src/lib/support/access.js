// src/lib/support/access.js
//
// SOW §29.3: granular agent permissions, following the existing financeRole / hrRole / nasRole precedent:
// an optional `supportRole` ("agent" | "manager") on the organization membership, plus optional
// `supportPermissions` adjustments. Owners and admins hold everything. Nothing about a customer is decided
// here: customers are a separate security domain (portalAuth.js).

import { canManageOrg } from "../orgGates.js";

export const SUPPORT_PERMISSIONS = [
  "view_tickets", "reply_public", "create_notes", "assign_tickets", "change_priority", "change_sla", "merge_tickets", "export_tickets",
  "view_invoices", "manage_kb", "manage_ideas", "use_ai", "admin_queues", "admin_sla", "admin_settings", "manage_agents",
];

const PRESETS = {
  agent: ["view_tickets", "reply_public", "create_notes", "assign_tickets", "change_priority", "view_invoices", "use_ai"],
  manager: [...SUPPORT_PERMISSIONS],
};

/** The set of permissions this membership holds. `supportPermissions` entries add ("merge_tickets") or remove ("-view_invoices"). */
export function supportPerms(membership) {
  if (!membership) return new Set();
  if (canManageOrg(membership)) return new Set(SUPPORT_PERMISSIONS);
  const base = new Set(PRESETS[membership.supportRole] || []);
  if (!base.size && !Array.isArray(membership.supportPermissions)) return new Set();
  for (const p of Array.isArray(membership.supportPermissions) ? membership.supportPermissions : []) {
    if (typeof p !== "string") continue;
    if (p.startsWith("-")) base.delete(p.slice(1)); else if (SUPPORT_PERMISSIONS.includes(p)) base.add(p);
  }
  return base;
}

export const canSupport = (membership, perm) => supportPerms(membership).has(perm);
export const isSupportStaff = (membership) => supportPerms(membership).has("view_tickets");
export const isSupportManager = (membership) => canManageOrg(membership) || membership?.supportRole === "manager";
