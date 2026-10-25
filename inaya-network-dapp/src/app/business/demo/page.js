// app/business/demo/page.js
//
// Public, shareable demo page for the Business Workspace (ERP mode): the
// 4-minute walkthrough video, what it covers, and the next steps. This is the
// link sent in pilot outreach emails. Visitors from Pakistan (Vercel's
// x-vercel-ip-country) also get the PKR pilot programme PDF; everyone else is
// pointed at pricing, which is region-aware on its own (src/lib/pkPricing.js).

import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Business Workspace Demo — a 4-minute walkthrough | Inaya Network",
  description: "Watch Inaya Business Workspace in action: HR, sales and CRM, invoicing, inventory, tasks and encrypted documents in one desktop-style ERP.",
  openGraph: {
    title: "Inaya Business Workspace — 4-minute demo",
    description: "HR, sales, invoicing, inventory, tasks and encrypted documents in one desktop-style ERP.",
    images: ["/videos/inaya-business-workspace-erp-demo-poster.jpg"],
  },
};

const CHAPTERS = [
  ["0:00", "Home dashboard: what needs attention today"],
  ["0:08", "Settings: classic ERP layout and themes"],
  ["0:28", "Sales: adding a customer"],
  ["1:05", "Accounting: an invoice in rupees, saved as a draft"],
  ["1:54", "Inventory: adding a product"],
  ["2:18", "People: adding an employee"],
  ["2:41", "Tasks: assigning a follow-up"],
  ["3:13", "Documents: encrypted company files"],
  ["3:49", "Back to the dashboard"],
];

export default async function BusinessDemoPage() {
  const country = (await headers()).get("x-vercel-ip-country");
  const isPk = String(country || "").toUpperCase() === "PK";

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-5xl mx-auto">
        <a href="/business" className="inline-block text-[#94a3b8] hover:text-slate-300 text-xs font-mono mb-4">← Business Workspace</a>
        <h1 className="text-3xl md:text-4xl font-extrabold text-white">
          Inaya Business Workspace <span className="bg-gradient-to-r from-[#00f2fe] to-violet-400 bg-clip-text text-transparent">in 4 minutes</span>
        </h1>
        <p className="text-[#94a3b8] text-sm mt-2 max-w-2xl">
          One system for your people, sales, accounting, purchasing, stock and documents, laid out like a classic desktop ERP, with your files encrypted before they leave your computer.
        </p>

        <div className="mt-6 rounded-2xl overflow-hidden border border-white/10 bg-black">
          <video
            controls
            playsInline
            preload="metadata"
            poster="/videos/inaya-business-workspace-erp-demo-poster.jpg"
            className="w-full h-auto block"
            src="/videos/inaya-business-workspace-erp-demo.mp4"
          />
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
            <p className="text-white text-sm font-bold mb-3">What the video shows</p>
            <ul className="space-y-1.5">
              {CHAPTERS.map(([time, label]) => (
                <li key={time} className="flex gap-3 text-[13px]">
                  <span className="font-mono text-[#00f2fe] w-10 shrink-0">{time}</span>
                  <span className="text-[#cbd5e1]">{label}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 flex flex-col gap-3">
            <p className="text-white text-sm font-bold">Try it with your team</p>
            {isPk ? (
              <>
                <p className="text-[#94a3b8] text-[13px]">6-month pilot for Pakistani companies: 30% off, setup and data import free, paid in rupees by bank transfer.</p>
                <a href="/documents/inaya-erp-pilot-programme-pakistan.pdf" target="_blank" rel="noreferrer" className="text-center text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-4 py-2.5 rounded-lg">Read the pilot programme (PDF)</a>
              </>
            ) : (
              <p className="text-[#94a3b8] text-[13px]">Every plan starts with a free trial. Pilot companies get hands-on setup and a say in what we build next.</p>
            )}
            <a href="/business/pricing" className="text-center text-[12px] font-bold uppercase text-white bg-white/5 border border-white/10 hover:bg-white/10 px-4 py-2.5 rounded-lg">See packages and pricing</a>
            <a href="/business" className="text-center text-[12px] font-bold uppercase text-white bg-white/5 border border-white/10 hover:bg-white/10 px-4 py-2.5 rounded-lg">Create your company workspace</a>
            <a href="mailto:contact@inayanetwork.com?subject=Business%20Workspace%20pilot" className="text-center text-[12px] text-[#94a3b8] hover:text-white">Questions? contact@inayanetwork.com</a>
          </div>
        </div>
      </div>
    </div>
  );
}
