import { orgBySlug } from "../../../../../lib/support/settings.js";
import { getPortalUser } from "../../../../../lib/support/portalAuth.js";
import { csrfCheck } from "../../../../../lib/support/portalApi.js";

export async function resolvePortal(req, routeCtx) {
  const { slug } = await routeCtx.params;
  const csrf = csrfCheck(req); if (csrf) return { error: csrf.error, status: csrf.status };
  const org = await orgBySlug(slug); if (!org) return { error: "This portal does not exist.", status: 404 };
  const orgId = String(org.orgId); org.settings.portalSlug = org.portalSlug;
  const user = await getPortalUser({ req, orgId }); if (!user) return { error: "Please sign in.", status: 401 };
  return { ctx: { kind: "portal", orgId, settings: org.settings, user } };
}
