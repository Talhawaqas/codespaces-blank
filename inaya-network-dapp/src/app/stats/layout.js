// app/stats/layout.js — see app/business/layout.js for why this pattern
// (server layout carrying metadata for a client page.js) exists.

export const metadata = {
  title: "Network Stats — Inaya Network",
  description: "Live, public network statistics for Inaya Network — active users, decentralized security metrics, and community growth.",
};

export default function StatsLayout({ children }) {
  return children;
}
