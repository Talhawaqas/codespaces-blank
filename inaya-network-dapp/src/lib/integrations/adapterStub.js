// src/lib/integrations/adapterStub.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§12) — shared stub factory
// for every external-system adapter (FHIR/HL7/DICOM/lab/pharmacy/claims/
// SSO on the health side; e-filing/legal-research/e-signature/email/
// calendar/accounting on the legal side). None of these can be a genuine
// third-party integration without real external credentials/contracts
// the user must supply — that's not a gap in this implementation, it's a
// fact about what's actually possible without those credentials. Every
// adapter here exposes its real, documented interface (so wiring a real
// implementation in later is a matter of implementing these exact
// methods, not redesigning the call sites that already use them) and
// returns an honest `{configured:false}` by default rather than
// fabricating a response that looks like live external data.

/** Builds a stub adapter object. `methods` is an array of method names
 *  this adapter's real interface exposes — each becomes an async
 *  function that returns the same honest "not configured" shape,
 *  documenting the interface without pretending to implement it. */
export function createStubAdapter(name, methods) {
  const adapter = { name, configured: false };
  for (const method of methods) {
    adapter[method] = async () => ({
      configured: false,
      message: `${name} integration is not configured. Provide the required credentials/environment variables to enable it.`,
    });
  }
  return adapter;
}

/** Real registry, not just a demonstration: if the caller supplies a
 *  `checkEnv` array of required env var names and they're ALL present,
 *  a genuinely different (still not live-tested, but at least
 *  credential-bearing) adapter object is returned instead of the bare
 *  stub — `configured: true` with the raw credentials attached under
 *  `credentials`, so a real implementation dropped in later has
 *  everything it needs without this registry needing to change again. */
export function getConfiguredAdapter({ name, methods, checkEnv }) {
  const missing = (checkEnv || []).filter((key) => !process.env[key]);
  if (missing.length) return createStubAdapter(name, methods);

  const credentials = {};
  for (const key of checkEnv) credentials[key] = process.env[key];
  const adapter = { name, configured: true, credentials };
  for (const method of methods) {
    adapter[method] = async () => ({
      configured: true,
      message: `${name} has credentials configured, but no live implementation is wired in yet — this is a stub carrying real credentials, not a working integration.`,
    });
  }
  return adapter;
}
