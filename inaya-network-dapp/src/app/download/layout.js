// app/download/layout.js — see app/business/layout.js for why this
// pattern (server layout carrying metadata for a client page.js) exists.

export const metadata = {
  title: "Download Inaya — Desktop Apps for Windows & Linux | Inaya Network",
  description: "Get the Inaya Network dApp and Business Workspace desktop apps for Windows and Linux — system-tray native apps with auto-updates and WalletConnect support.",
};

export default function DownloadLayout({ children }) {
  return children;
}
