import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessInfrastructure } from "../../../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../../../lib/featureFlags.js";
import { InfrastructureError } from "../../../../../../../lib/infrastructure/nodes.js";
import { getKubeconfig } from "../../../../../../../lib/infrastructure/k8sClusters.js";

// Real kubeconfig download -- the customer uses their own real `kubectl`
// against it, matching the Terraform-provider precedent of handing over
// real tooling rather than rebuilding it. Deliberately its own route (not
// folded into the cluster GET above) so the decrypted secret only ever
// leaves the server on an explicit, auditable download action.
export async function GET(req, ctx) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const off = await requireFeature("FEATURE_INFRASTRUCTURE", orgId);
    if (off) return NextResponse.json({ error: off.error }, { status: off.status });
    if (!canAccessInfrastructure(auth.membership)) return NextResponse.json({ error: "You do not have access to Infrastructure." }, { status: 403 });
    const { k8sClusterId } = await ctx.params;
    const kubeconfig = await getKubeconfig({ orgId, k8sClusterId });
    return new NextResponse(kubeconfig, {
      status: 200,
      headers: { "Content-Type": "application/yaml", "Content-Disposition": `attachment; filename="inaya-${k8sClusterId}.kubeconfig.yaml"`, "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof InfrastructureError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("kubeconfig download failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
