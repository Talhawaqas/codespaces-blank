// GET /api/orgs/documents-automation/types?orgId=
//   -> the document-type registry (what can be generated, from which kind of
//      record, which options each accepts) plus the template registry.
import { NextResponse } from "next/server";
import { authed, fail, dynamic as _d } from "../_lib.js";
import { listDocumentTypes, getDocumentType } from "../../../../../lib/documentAutomation/documentTypes.js";
import { listTemplates } from "../../../../../lib/documentAutomation/templateStore.js";
import { SUPPORTED_LOCALES, LABEL_KEYS } from "../../../../../lib/documentAutomation/i18n.js";
import { BLOCK_TYPES, FORMATS, CONDITION_OPS, TABLE_SOURCES, FIELD_PATHS } from "../../../../../lib/documentAutomation/templateSchema.js";
import { SUPPORTED_CURRENCIES } from "../../../../../lib/currency.js";

export const dynamic = "force-dynamic";
void _d;

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const types = listDocumentTypes().map((t) => ({ ...t, canGenerate: getDocumentType(t.id).canGenerate(a.membership), canApprove: getDocumentType(t.id).canApprove(a.membership) }));
    const templates = (await listTemplates({ orgId })).map(({ spec, ...rest }) => rest);
    return NextResponse.json({ types, templates, locales: SUPPORTED_LOCALES, currencies: SUPPORTED_CURRENCIES, pageSizes: ["A4", "LETTER"], templateLanguage: { blockTypes: BLOCK_TYPES, formats: FORMATS, conditionOps: CONDITION_OPS, tableSources: TABLE_SOURCES, fieldPaths: FIELD_PATHS.invoice, labelKeys: LABEL_KEYS } });
  } catch (err) { return fail(err, "types GET"); }
}
