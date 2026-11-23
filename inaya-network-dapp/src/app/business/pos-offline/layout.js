// app/business/pos-offline/layout.js -- the offline till page is a tool for shop computers, not a public page.
export const metadata = { title: "Offline till — Inaya Business Workspace", robots: { index: false, follow: false } };
export default function PosOfflineLayout({ children }) { return children; }
