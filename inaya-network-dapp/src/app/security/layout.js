// app/security/layout.js — see app/business/layout.js for why this
// pattern (server layout carrying metadata for a client page.js) exists.

export const metadata = {
  title: "Inaya Firewall — Decentralized Threat Intelligence | Inaya Network",
  description: "Check any domain or IP against Inaya's decentralized, reputation-weighted threat intelligence network — every confirmation is anchored on-chain so the record can't quietly change later.",
};

export default function SecurityLayout({ children }) {
  return children;
}
