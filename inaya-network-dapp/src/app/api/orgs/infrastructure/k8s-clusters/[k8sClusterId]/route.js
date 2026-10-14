import { route } from "../../_lib.js";
import * as K from "../../../../../../lib/infrastructure/k8sClusters.js";

// Never returns kubeconfigEncrypted/nodeTokenEncrypted -- those stay
// server-side; the kubeconfig itself is only ever handed out through the
// dedicated /kubeconfig download route below, as real customer tooling
// (kubectl) consumes it, never rendered into this JSON payload.
function sanitize(doc) {
  const { kubeconfigEncrypted, nodeTokenEncrypted, ...rest } = doc;
  return rest;
}

export const GET = (req, ctx) => route(req, ctx, async ({ orgId, params }) => sanitize(await K.getK8sCluster({ orgId, k8sClusterId: params.k8sClusterId })));

export const DELETE = (req, ctx) => route(req, ctx, ({ orgId, membership, params }) => K.deleteK8sCluster({ orgId, membership, k8sClusterId: params.k8sClusterId }), { requireManage: true });
