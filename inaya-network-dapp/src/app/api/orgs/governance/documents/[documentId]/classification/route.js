// app/api/orgs/governance/documents/[documentId]/classification/route.js
//   GET                          current level, source, confidence, pending suggestion and the full history
//   POST { action }              classify {text? only for server-managed objects, force?} | override {level|null, reason} | accept {reason?} | reject {reason?}
//                                | report {level, ruleIds, confidence, scanner} (client / customer scanner verdict) | ai {text}
import * as K from "../../../../../../../lib/governance/classification.js";
import { GovError } from "../../../../../../../lib/governance/policies.js";
import { getOrgCollections, toObjectId } from "../../../../../../../lib/orgs.js";
import { govRoute, json } from "../../../_lib.js";
export const dynamic = "force-dynamic";
const F = "FEATURE_SMART_CLASSIFICATION";
export const GET = (req, ctx) => govRoute(req, ctx, F, ({ orgId, membership, email, params }) => K.classificationHistory({ orgId, documentId: params.documentId, membership, email }));
export const POST = (req, ctx) => govRoute(req, ctx, F, async ({ orgId, membership, email, body, params }) => {
  const a = { orgId, documentId: params.documentId, membership, email };
  switch (body.action) {
    case "classify": {
      // Text is accepted only for objects the server legitimately holds in readable form. Anything end-to-end encrypted must use "report".
      if (body.text !== undefined) {
        const { orgDocuments } = await getOrgCollections(); const d = await orgDocuments.findOne({ _id: toObjectId(params.documentId), orgId: toObjectId(orgId) }, { projection: { encryptionMode: 1 } });
        if (d?.encryptionMode !== "server-managed") throw new GovError(409, "This file is end-to-end encrypted. Classify it in your browser or scanner and send the result instead.", { code: "USE_CLIENT_REPORT" });
      }
      return K.classifyDocument({ ...a, text: body.text ?? null, source: body.text ? "server_text" : "rules", force: !!body.force, dryRun: !!body.dryRun });
    }
    case "override": return K.overrideClassification({ ...a, level: body.level ?? null, reason: body.reason });
    case "accept": return K.decideSuggestion({ ...a, accept: true, reason: body.reason });
    case "reject": return K.decideSuggestion({ ...a, accept: false, reason: body.reason });
    case "report": return K.reportClientClassification({ ...a, level: body.level, ruleIds: body.ruleIds, confidence: body.confidence, scanner: body.scanner });
    case "ai": {
      const { orgDocuments } = await getOrgCollections(); const d = await orgDocuments.findOne({ _id: toObjectId(params.documentId), orgId: toObjectId(orgId) }, { projection: { encryptionMode: 1 } });
      if (d?.encryptionMode !== "server-managed") throw new GovError(409, "AI assistance only works on content the server is allowed to read. This file is end-to-end encrypted.", { code: "USE_CLIENT_REPORT" });
      return K.suggestWithAi({ ...a, text: body.text });
    }
    default: return json({ error: "Unknown action." }, 400);
  }
});
