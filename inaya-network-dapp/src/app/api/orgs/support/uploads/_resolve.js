import { requireMembership } from "../../../../../lib/orgs.js";
import { getSettings } from "../../../../../lib/support/settings.js";

export async function resolveAgent(req) {
  const orgId = new URL(req.url).searchParams.get("orgId");
  if (!orgId) return { error: "orgId is required.", status: 400 };
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };
  return { ctx: { kind: "agent", orgId, settings: await getSettings(orgId), membership: auth.membership, email: auth.session.email } };
}
