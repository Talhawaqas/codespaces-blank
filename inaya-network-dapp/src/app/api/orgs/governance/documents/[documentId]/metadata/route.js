// app/api/orgs/governance/documents/[documentId]/metadata/route.js
//   GET  values and fields the caller may see (needs view access)      PUT { values } set values (needs edit access; manager-only fields need manage)
import * as M from "../../../../../../../lib/governance/metadata.js";
import { govRoute } from "../../../_lib.js";
export const dynamic = "force-dynamic";
const F = "FEATURE_FILE_GOVERNANCE";
export const GET = (req, ctx) => govRoute(req, ctx, F, ({ orgId, membership, email, params }) => M.getDocumentMetadata({ orgId, documentId: params.documentId, membership, email }));
export const PUT = (req, ctx) => govRoute(req, ctx, F, ({ orgId, membership, email, body, params }) => M.setDocumentMetadata({ orgId, documentId: params.documentId, membership, email, values: body.values, strict: !!body.strict }));
