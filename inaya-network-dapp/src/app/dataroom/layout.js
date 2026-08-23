// app/dataroom/layout.js
//
// Deliberately noindex: this is an NDA-gated investor data room. It
// should be reached by direct/invite link, not organic search — indexing
// it would surface a "request access to investor documents" page to
// random search traffic, which isn't the goal. See app/business/layout.js
// for why a server layout carries metadata here (page.js is a client
// component and can't export it directly).

export const metadata = {
  title: "Investor Data Room — Inaya Network",
  description: "NDA-gated access to Inaya Network's investor documents and financial materials.",
  robots: { index: false, follow: false },
};

export default function DataroomLayout({ children }) {
  return children;
}
