// src/lib/integrations/sso.js
//
// Healthcare & Legal Expansion SOW, Phase 10/13 (§13) — SSO / enterprise
// provisioning. Shared across both verticals (and general orgs) rather
// than duplicated per-vertical, matching SOW section 13's own framing as
// a cross-cutting concern, not a health- or legal-specific one. Real SSO
// (SAML/OIDC) requires an identity-provider registration this app cannot
// self-configure — stubbed per the same discipline as every other
// adapter in this SOW. Preserves the existing organization identity
// model: a real implementation would map an incoming SSO assertion to an
// existing org_members record by email, never create a parallel identity
// system alongside it.

import { getConfiguredAdapter } from "./adapterStub.js";

export function getSsoAdapter() {
  return getConfiguredAdapter({
    name: "SSO / Enterprise Provisioning",
    methods: ["initiateSamlLogin", "handleSamlAssertion", "initiateOidcLogin", "handleOidcCallback", "provisionUser", "deprovisionUser", "syncRoleMapping"],
    checkEnv: ["SSO_PROVIDER_TYPE", "SSO_METADATA_URL", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET"],
  });
}
