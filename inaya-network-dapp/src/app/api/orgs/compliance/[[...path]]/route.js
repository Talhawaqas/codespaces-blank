// app/api/orgs/compliance/[[...path]]/route.js -- compliance readiness, government profile and key management (Competitive Expansion SOW P and Q). Session + membership.
//
//   FEATURE_COMPLIANCE_READINESS
//     GET summary                         readiness overview (families, evidence, exceptions)    GET controls?family=&implementation=&evidence=&responsibility=&owner=&q=
//     GET controls/{id}                   one control with live facts                            PATCH controls/{id} { implementation?, responsibility?, ownerEmail?, statement? }
//     POST controls/{id}/evidence { ref } attach (vault | snapshot | link)                       DELETE controls/{id}/evidence/{refId}
//     POST controls/{id}/exception { reason, compensating, expiresAt }    DELETE controls/{id}/exception
//     POST snapshot                       take a point-in-time snapshot of the live facts        GET facts      live collector facts
//     GET package                         the evidence package (OSCAL-shaped SSP + sections), downloadable JSON
//     GET crypto                          cryptography inventory, FIPS status, provider capabilities, self-test results
//   FEATURE_GOVERNMENT_SECURITY_PROFILE
//     GET government                      PUT government { state, ipPolicy?, authorization? }    POST government/labels   GET government/access
//   FEATURE_CUSTOMER_MANAGED_KEYS (changes only; reading status is always allowed to the roles named in the service)
//     GET keys   POST keys/configure { provider, keyRef, region?, endpoint?, acknowledgeDestruction }   POST keys/rotate   POST keys/state { state }   GET keys/audit
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../lib/featureFlags.js";
import * as IMPL from "../../../../../lib/compliance/implementation.js";
import * as GOV from "../../../../../lib/compliance/governmentProfile.js";
import { collectAll } from "../../../../../lib/compliance/collectors.js";
import { buildPackage, OscalError } from "../../../../../lib/compliance/oscal.js";
import { KeyError } from "../../../../../lib/keys/providers.js";
import * as KS from "../../../../../lib/keys/service.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200, h = {}) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", ...h } });

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const url = new URL(req.url); const q = Object.fromEntries(url.searchParams.entries()); let body = {};
    if (["POST", "PUT", "PATCH"].includes(method)) { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const membership = auth.membership, actorEmail = auth.session.email; const base = { orgId, membership, actorEmail }; const [a, b, c, d] = path;
    const need = async (flag) => { const off = await requireFeature(flag, orgId); return off ? json({ error: off.error }, off.status) : null; };

    if (a === "keys") {
      if (method === "GET" && !b) return json(await KS.status({ orgId, membership })); if (method === "GET" && b === "audit") return json(await KS.listAudit({ orgId, membership, limit: q.limit }));
      const off = await need("FEATURE_CUSTOMER_MANAGED_KEYS"); if (off) return off;
      if (method === "POST" && b === "configure") return json(await KS.configure({ ...base, provider: body.provider, keyRef: body.keyRef, region: body.region, endpoint: body.endpoint, acknowledgeDestruction: body.acknowledgeDestruction === true }));
      if (method === "POST" && b === "rotate") return json(await KS.rotate({ ...base, keyRef: body.keyRef, region: body.region, endpoint: body.endpoint })); if (method === "POST" && b === "state") return json(await KS.setState({ ...base, state: body.state }));
    }
    if (a === "government") {
      const off = await need("FEATURE_GOVERNMENT_SECURITY_PROFILE"); if (off) return off;
      if (!b && method === "GET") return json(await GOV.getProfile({ orgId, membership })); if (!b && method === "PUT") return json(await GOV.setProfile({ ...base, state: body.state, ipPolicy: body.ipPolicy, authorization: body.authorization }));
      if (b === "labels" && method === "POST") return json(await GOV.applyGovernmentLabels(base)); if (b === "access" && method === "GET") return json(await GOV.listAccess({ orgId, membership, limit: q.limit }));
    }
    const off = await need("FEATURE_COMPLIANCE_READINESS"); if (off) return off;
    if (a === "summary" && method === "GET") return json(await IMPL.summary({ orgId, membership }));
    if (a === "controls") {
      if (!b && method === "GET") return json(await IMPL.listControls({ orgId, membership, family: q.family, implementation: q.implementation, evidence: q.evidence, responsibility: q.responsibility, owner: q.owner, q: q.q }));
      if (b && !c && method === "GET") return json(await IMPL.getControl({ orgId, membership, controlId: b })); if (b && !c && method === "PATCH") return json(await IMPL.updateControl({ ...base, controlId: b, patch: body }));
      if (b && c === "evidence" && method === "POST") return json(await IMPL.attachEvidence({ ...base, controlId: b, ref: body.ref })); if (b && c === "evidence" && d && method === "DELETE") return json(await IMPL.removeEvidence({ ...base, controlId: b, refId: d }));
      if (b && c === "exception" && method === "POST") return json(await IMPL.setException({ ...base, controlId: b, reason: body.reason, compensating: body.compensating, expiresAt: body.expiresAt })); if (b && c === "exception" && method === "DELETE") return json(await IMPL.closeException({ ...base, controlId: b }));
    }
    if (a === "snapshot" && method === "POST") return json(await IMPL.takeSnapshot(base), 201);
    if (a === "facts" && method === "GET") { if (!IMPL.canRead(membership)) return json({ error: "Only compliance staff, administrators and auditors can see these facts." }, 403); return json({ facts: await collectAll(orgId) }); }
    if (a === "package" && method === "GET") { const pkg = await buildPackage({ orgId, membership }); return json(pkg, 200, { "Content-Disposition": `attachment; filename="evidence-package-${pkg.generatedAt.slice(0, 10)}.json"` }); }
    if (a === "crypto" && method === "GET") { if (!IMPL.canRead(membership)) return json({ error: "Only compliance staff, administrators and auditors can see the cryptography inventory." }, 403); const P = await import("../../../../../lib/crypto/policy.js"); return json({ ...(await P.inventory()), selfTest: P.selfTest(), selfTestNoble: await P.selfTestNoble() }); }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof IMPL.ComplianceError || err instanceof GOV.GovProfileError || err instanceof OscalError) return json({ error: err.message }, err.status);
    if (err instanceof KeyError) return json({ error: err.message, code: err.code }, err.status);
    console.error("orgs/compliance failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
