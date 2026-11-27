// GET /api/analytics/v1/datasets/{name}?from=&to=&cursor=&limit=  (Bearer access token) -> one page of rows + the next cursor.
import { requireAnalyticsToken } from "../../../../../../lib/analytics/oauth.js";
import { readDataset } from "../../../../../../lib/analytics/datasets.js";
import { logOrgActivity } from "../../../../../../lib/org-activity-log.js";
import { toObjectId } from "../../../../../../lib/orgs.js";
import { json, handle } from "../../../_lib.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req, ctx) {
  try {
    const a = await requireAnalyticsToken(req);
    const { name } = await ctx.params;
    const query = Object.fromEntries(new URL(req.url).searchParams.entries());
    const out = await readDataset({ orgId: a.orgId, membership: a.membership, name, query });
    // One audit record per extraction (its first page), not per page: who, which dataset, which window (SOW 8.4).
    if (!query.cursor) {
      await logOrgActivity({ orgId: a.orgId, recordType: "POWER_BI", recordId: toObjectId(String(a.grant._id)), actorEmail: a.email, action: "POWERBI_DATA_READ", previousState: null, newState: null,
        metadata: { dataset: name, from: out.window?.from || null, to: out.window?.to || null, firstPageRows: out.rowCount } }).catch(() => {});
    }
    return json(out);
  } catch (err) { return handle(err, "dataset"); }
}
