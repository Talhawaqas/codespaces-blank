// src/lib/identity/twin.js
//
// SOW §36 (Digital Twin preview) and §38's "what would happen" surface: before a person's access is removed, show what depends on them.
// Reuses the existing EMPLOYEE_ACCESS_REMOVED scenario of the Digital Twin (projects and tasks that depend on the person) and adds what the
// identity layer itself knows: the grants and their sources, sessions, service credentials, shares, temporary access they sponsor, and open
// orphan risk. Read-only. The simulation is recorded by the Digital Twin's own audit entry, as with every other scenario.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { fail, normEmail } from "./common.js";
import { explainAccess } from "./grants.js";
import { analyzeManagerReplacement } from "./orphans.js";

export async function previewAccessRemoval({ orgId, email: rawEmail, membership, actorEmail }) {
  const email = normEmail(rawEmail); const oid = toObjectId(orgId);
  const org = await getOrgCollections(); const { identityCredentials } = await getIdentityCollections();
  const m = await org.orgMembers.findOne({ orgId: oid, email });
  if (!m) return fail("That person is not a member of this organization.", 404);
  const { simulateDigitalTwinScenario } = await import("../digitalTwinSimulate.js");
  const sim = await simulateDigitalTwinScenario({ orgId, scenarioType: "EMPLOYEE_ACCESS_REMOVED", entityId: email, membership, actorEmail, params: { source: "identity" } });
  const access = await explainAccess({ orgId, email });
  const [sessions, serviceCreds, shares, dependents] = await Promise.all([
    org.sessions.countDocuments({ email }),
    identityCredentials.countDocuments({ orgId: oid, createdBy: email, revokedAt: null }),
    org.documentShares.countDocuments({ orgId: oid, createdByEmail: email, revokedAt: null }),
    m.role === "owner" ? null : analyzeManagerReplacement({ orgId, email }),
  ]);
  return {
    subject: email, membershipStatus: m.status, role: m.role,
    ownerProtected: m.role === "owner" ? "Owners are protected: access removal through identity integration is refused unless another active owner exists." : null,
    identityImpact: { grants: access.grants.filter((g) => g.status === "ACTIVE").map((g) => ({ kind: g.kind, value: g.label || g.value, source: g.sourceLabel, until: g.until })), activeSessions: sessions, serviceCredentialsCreatedByThem: serviceCreds, activeSharesCreatedByThem: shares },
    businessImpact: sim.error ? { unavailable: sim.error } : { directImpact: sim.simulation.directImpact, unknowns: sim.simulation.unknowns, resultStatus: sim.simulation.resultStatus, simulationId: sim.simulation.simulationId, integrityHash: sim.simulation.integrityHash },
    dependents: dependents && !dependents.error ? { soleProjects: dependents.soleProjects, openTasks: dependents.openTasks, openTickets: dependents.openTickets, sponsoredTemporaryAccess: dependents.sponsoredTemporaryAccess, replacementCandidates: dependents.replacementCandidates } : null,
    noChangesWereMade: true,
  };
}
