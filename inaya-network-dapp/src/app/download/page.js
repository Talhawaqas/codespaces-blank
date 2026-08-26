"use client";

// app/download/page.js
//
// Combined download hub for BOTH Inaya desktop apps -- the main dApp
// (faucet, node registry, staking, KYC, referrals, watcher pioneer) and
// the Business Workspace (departments, projects, encrypted documents,
// approvals, AI Assistant). Each ships as its own separate installer with
// its own auto-updater. Files are served as static assets from
// public/downloads/ rather than proxied through GitHub Releases, so this
// page keeps working even if the release repo/tag layout changes later.
// No auth required to view it.

const APPS = [
  {
    id: "dapp",
    name: "Inaya Network",
    tagline: "dApp Desktop App",
    description: "The faucet, node registry, staking, KYC, and referrals — as a real app on your computer. Runs in your system tray and updates itself.",
    note: "Wallet connection: use WalletConnect when prompted — MetaMask/Trust/Coinbase need a browser extension, which doesn't exist inside the desktop app. The app detects this automatically and leads with WalletConnect for you.",
    webLink: { href: "/", label: "inayanetwork.com" },
    downloads: [
      {
        os: "Windows",
        icon: "🪟",
        file: "/downloads/dapp/Inaya-Network-Setup-x64.exe",
        label: "Download for Windows",
        sub: ".exe installer · x64",
        instructions: "Run the installer and follow the prompts. Windows may show a SmartScreen warning since this build isn't code-signed yet — click \"More info\" → \"Run anyway\" to proceed.",
      },
      {
        os: "Windows (Portable)",
        icon: "🪟",
        file: "/downloads/dapp/Inaya-Network-Portable-x64.exe",
        label: "Download Portable",
        sub: "Single .exe · no install needed",
        instructions: "No installer, no registry changes, no admin rights needed — just run it. Needs the Microsoft Edge WebView2 Runtime already on your machine (present by default on Windows 10 1803+ and Windows 11). Doesn't auto-update — re-download for new versions.",
      },
      {
        os: "Linux (AppImage)",
        icon: "🐧",
        file: "/downloads/dapp/Inaya-Network-x86_64.AppImage",
        label: "Download AppImage",
        sub: "Works on most distros · no install needed",
        instructions: "Make it executable and run it:\nchmod +x Inaya-Network-x86_64.AppImage\n./Inaya-Network-x86_64.AppImage",
      },
      {
        os: "Linux (.deb)",
        icon: "🐧",
        file: "/downloads/dapp/Inaya-Network-amd64.deb",
        label: "Download .deb",
        sub: "Debian / Ubuntu",
        instructions: "sudo dpkg -i Inaya-Network-amd64.deb",
      },
    ],
  },
  {
    id: "business-workspace",
    name: "Business Workspace",
    tagline: "Business Desktop App",
    description: "Same Business Workspace — departments, projects, encrypted documents, approvals, AI Assistant — as a real app on your computer. Runs in your system tray, notifies you when something needs your approval, and updates itself.",
    note: null,
    webLink: { href: "/business", label: "inayanetwork.com/business" },
    downloads: [
      {
        os: "Windows",
        icon: "🪟",
        file: "/downloads/business-workspace/Inaya-Business-Workspace-Setup-x64.exe",
        label: "Download for Windows",
        sub: ".exe installer · x64",
        instructions: "Run the installer and follow the prompts. Windows may show a SmartScreen warning since this build isn't code-signed yet — click \"More info\" → \"Run anyway\" to proceed.",
      },
      {
        os: "Windows (Portable)",
        icon: "🪟",
        file: "/downloads/business-workspace/Inaya-Business-Workspace-Portable-x64.exe",
        label: "Download Portable",
        sub: "Single .exe · no install needed",
        instructions: "No installer, no registry changes, no admin rights needed — just run it. Needs the Microsoft Edge WebView2 Runtime already on your machine (present by default on Windows 10 1803+ and Windows 11). Doesn't auto-update — re-download for new versions.",
      },
      {
        os: "Linux (AppImage)",
        icon: "🐧",
        file: "/downloads/business-workspace/Inaya-Business-Workspace-x86_64.AppImage",
        label: "Download AppImage",
        sub: "Works on most distros · no install needed",
        instructions: "Make it executable and run it:\nchmod +x Inaya-Business-Workspace-x86_64.AppImage\n./Inaya-Business-Workspace-x86_64.AppImage",
      },
      {
        os: "Linux (.deb)",
        icon: "🐧",
        file: "/downloads/business-workspace/Inaya-Business-Workspace-amd64.deb",
        label: "Download .deb",
        sub: "Debian / Ubuntu",
        instructions: "sudo dpkg -i Inaya-Business-Workspace-amd64.deb",
      },
    ],
  },
];

export default function DownloadHubPage() {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-5xl mx-auto">
        <a href="/" className="inline-block text-[#94a3b8] hover:text-slate-300 text-xs font-mono mb-4">← Inaya Network</a>
        <div className="flex items-center gap-2.5 mb-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
            <span className="text-black font-extrabold text-sm">I</span>
          </div>
          <span className="text-white font-extrabold tracking-wide">INAYA</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold text-white mb-2">
          Inaya <span className="bg-gradient-to-r from-[#00f2fe] to-violet-400 bg-clip-text text-transparent">Desktop Apps</span>
        </h1>
        <p className="text-[#94a3b8] text-sm mb-2 max-w-2xl">
          Two separate apps, each with its own installer and auto-updater — pick the one you need below.
        </p>
        <p className="text-amber-400/80 text-xs font-mono mb-10">
          ⚠ Testnet release. If something looks wrong, please report it — that's exactly the feedback we need right now.
        </p>

        {APPS.map((app) => (
          <div key={app.id} className="mb-14">
            <h2 className="text-xl md:text-2xl font-extrabold text-white mb-1">
              {app.name} <span className="text-[#8a96ab] font-semibold">— {app.tagline}</span>
            </h2>
            <p className="text-[#94a3b8] text-sm mb-2 max-w-2xl">{app.description}</p>
            {app.note && (
              <p className="text-[#94a3b8] text-sm mb-2 max-w-2xl">
                <strong className="text-slate-200">Wallet connection:</strong>{" "}
                use <strong className="text-[#00f2fe]">WalletConnect</strong> when prompted — MetaMask/Trust/Coinbase need a browser extension, which doesn't exist inside the desktop app. The app detects this automatically and leads with WalletConnect for you.
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
              {app.downloads.map((d) => (
                <div key={d.file} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 flex flex-col">
                  <div className="text-3xl mb-3">{d.icon}</div>
                  <h3 className="text-white font-bold text-lg mb-1">{d.os}</h3>
                  <p className="text-[#8a96ab] text-xs font-mono mb-4">{d.sub}</p>
                  <a
                    href={d.file}
                    download
                    className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 text-center hover:opacity-90 transition-opacity mb-4"
                  >
                    {d.label}
                  </a>
                  <pre className="text-[12px] text-[#94a3b8] font-mono whitespace-pre-wrap leading-relaxed bg-black/30 border border-white/5 rounded-lg p-3 mt-auto">
                    {d.instructions}
                  </pre>
                </div>
              ))}
            </div>

            <div className="mt-4 bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
              <p className="text-white text-sm font-bold mb-1">macOS</p>
              <p className="text-[#94a3b8] text-xs">
                Not available yet. Use {app.name} in your browser at{" "}
                <a href={app.webLink.href} className="text-[#00f2fe] hover:underline">{app.webLink.label}</a> in the meantime.
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
