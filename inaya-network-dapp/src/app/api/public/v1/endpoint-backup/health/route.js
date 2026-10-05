// GET /api/public/v1/endpoint-backup/health   backup health across the organization's endpoint profiles (read-only). Requires FEATURE_ENDPOINT_BACKUP_V2.
//   Restore jobs stay in the app: they need a person to review the ransomware-safe plan.
import { healthOverview } from "../../../../../../lib/endpoint/backup.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_ENDPOINT_BACKUP_V2" }, ({ orgId, membership }) => healthOverview({ orgId, membership }));
