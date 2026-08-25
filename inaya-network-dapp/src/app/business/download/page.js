"use client";

// app/business/download/page.js
//
// Public download page for the Business Workspace desktop app (Windows +
// Linux). Files are served as static assets from public/downloads/ rather
// than proxied through GitHub Releases, so this page keeps working even if
// the release repo/tag layout changes later. No auth required to view it.

const DOWNLOADS = [
  {
    os: "Windows",
    icon: "🪟",
    file: "/downloads/business-workspace/Inaya-Business-Workspace-Setup-x64.exe",
    label: "Download for Windows",
    sub: ".exe installer · x64",
    instructions: "Run the installer and follow the prompts. Windows may show a SmartScreen warning since this build isn't code-signed yet — click \"More info\" → \"Run anyway\" to proceed.",
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
];

export default function BusinessWorkspaceDownloadPage() {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-4xl mx-auto">
        <a href="/business" className="inline-block text-[#94a3b8] hover:text-slate-300 text-xs font-mono mb-4">← Business Workspace</a>
        <div className="flex items-center gap-2.5 mb-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
            <span className="text-black font-extrabold text-sm">I</span>
          </div>
          <span className="text-white font-extrabold tracking-wide">INAYA</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold text-white mb-2">
          Business Workspace <span className="bg-gradient-to-r from-[#00f2fe] to-violet-400 bg-clip-text text-transparent">Desktop App</span>
        </h1>
        <p className="text-[#94a3b8] text-sm mb-2 max-w-2xl">
          Same Business Workspace — departments, projects, encrypted documents, approvals, AI Assistant — as a real app on your computer. Runs in your system tray, notifies you when something needs your approval, and updates itself.
        </p>
        <p className="text-amber-400/80 text-xs font-mono mb-10">
          ⚠ Testnet release. If something looks wrong, please report it — that's exactly the feedback we need right now.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {DOWNLOADS.map((d) => (
            <div key={d.file} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 flex flex-col">
              <div className="text-3xl mb-3">{d.icon}</div>
              <h2 className="text-white font-bold text-lg mb-1">{d.os}</h2>
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

        <div className="mt-10 bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
          <p className="text-white text-sm font-bold mb-1">macOS</p>
          <p className="text-[#94a3b8] text-xs">Not available yet. Use the Business Workspace in your browser at <a href="/business" className="text-[#00f2fe] hover:underline">inayanetwork.com/business</a> in the meantime.</p>
        </div>
      </div>
    </div>
  );
}
