// src/lib/integrations/legal/emailAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§11.22, §12) — email
// integration adapter. SOW §11.22 is explicit: "Email integration
// remains separate from the vault" — this adapter is for reading/
// threading external counsel/client email, never a replacement for
// legal-messages.js's own secure, audited, matter-associated messaging.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getEmailAdapter() {
  return getConfiguredAdapter({
    name: "Email",
    methods: ["listThreadsForMatter", "sendEmail"],
    checkEnv: ["EMAIL_INTEGRATION_PROVIDER", "EMAIL_INTEGRATION_API_KEY"],
  });
}
