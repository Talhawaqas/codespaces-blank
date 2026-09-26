import { requireSupportApiKey } from "../../../../../../lib/support/apiKeys.js";

export async function resolveApi(req) {
  const a = await requireSupportApiKey(req, "attachments:write");
  if (a.error) return { error: a.error, status: a.status };
  return { ctx: { kind: "api", orgId: a.ctx.orgId, settings: a.ctx.settings, customerEmail: a.ctx.customerEmail, keyId: a.ctx.keyId } };
}
