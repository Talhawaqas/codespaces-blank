// src/lib/integrations/legal/accountingAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§12) — external accounting
// system sync adapter (QuickBooks-style), for legal-billing-workflow.js
// and trust-accounting.js to eventually sync ledger entries to a firm's
// real accounting system. No live sync happens today — see
// trust-accounting.js's own header for why reconciliation there is a
// foundation, not a jurisdictional-compliance claim.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getAccountingAdapter() {
  return getConfiguredAdapter({
    name: "Accounting Sync",
    methods: ["syncInvoice", "syncTrustLedgerEntry", "getAccountBalance"],
    checkEnv: ["ACCOUNTING_PROVIDER_URL", "ACCOUNTING_API_KEY"],
  });
}
