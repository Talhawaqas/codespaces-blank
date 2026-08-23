// app/business/download/layout.js — see app/business/layout.js for why
// this pattern (server layout carrying metadata for a client page.js)
// exists.

export const metadata = {
  title: "Download Business Workspace — Inaya Network",
  description: "Get the Inaya Business Workspace desktop app — encrypted document management for teams, native on Windows and Linux with auto-updates.",
};

export default function BusinessDownloadLayout({ children }) {
  return children;
}
