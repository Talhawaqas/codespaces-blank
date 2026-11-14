// app/api/public/v1/_engagement.js -- shared helpers for the Appointments & Campaigns public API.
// Same org binding as every public/v1 route (org from the API key), plus the Business/Enterprise plan gate.
// Library functions return { error, status }; this turns that into the error shape publicRoute already answers with.
import { engagementAccess } from "../../../../lib/engagement/store.js";

export function unwrap(r) {
  if (r?.error) { const e = new Error(r.error); e.status = r.status || 400; throw e; }
  return r;
}

export async function gate(orgId, module) {
  const g = await engagementAccess(orgId, module);
  if (g) { const e = new Error(g.error); e.status = g.status; throw e; }
}
