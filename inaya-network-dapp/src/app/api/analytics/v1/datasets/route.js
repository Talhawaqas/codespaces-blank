// GET /api/analytics/v1/datasets  (Bearer access token) -> the dataset catalogue and data dictionary for this person and company.
import { requireAnalyticsToken } from "../../../../../lib/analytics/oauth.js";
import { catalogue, API_VERSION, MAX_PAGE, MAX_WINDOW_DAYS } from "../../../../../lib/analytics/datasets.js";
import { getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";
import { json, handle } from "../../_lib.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const a = await requireAnalyticsToken(req);
    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(a.orgId) }, { projection: { name: 1 } });
    return json({ apiVersion: API_VERSION, company: { id: a.orgId, name: org?.name || null }, user: a.email,
      limits: { maxPageSize: MAX_PAGE, maxWindowDays: MAX_WINDOW_DAYS, requestsPer10Minutes: 600 }, datasets: catalogue(a.membership) });
  } catch (err) { return handle(err, "catalogue"); }
}
