// app/account-deletion/page.js
//
// Public page for "delete my account and data" requests. Google Play requires a web address, usable without installing the app, where a person can ask for
// their account and its data to be deleted (it is entered in the Play Console Data safety section). It states what happens as it is today: a request by e-mail,
// checked by a person, and what cannot be removed (on-chain records, legal or financial record keeping). Matches section 5 of the privacy policy.

export const metadata = {
  title: "Delete your account and data — Inaya Network",
  description: "How to ask Inaya Network to delete your account and the personal data linked to it, and what is and is not removed.",
};

const steps = [
  "Send an e-mail to contact@inayanetwork.com from the e-mail address of the account you want deleted (or, for a wallet-only account, tell us the wallet address and we will ask you to prove you control it).",
  "Use the subject line: Delete my Inaya account.",
  "We reply to that address to confirm the request, so nobody else can delete your account.",
  "Once confirmed we delete the account and the data listed below, and send you a message when it is done. We aim to finish within 30 days.",
];
const deleted = [
  "Your Business Workspace account: e-mail address, sign-in sessions, memberships and personal settings.",
  "Identity-verification (KYC) status held by Inaya. The verification provider (Didit) keeps its own records under its own policy and we pass the deletion request on to it.",
  "Files and records you stored through Inaya that we are able to remove. Encrypted content is unpinned from our storage; content that was already copied to a public network by design may persist there, encrypted, and cannot be recalled by us.",
  "Notification and device records linked to your account.",
];
const kept = [
  "Records written to a blockchain (for example staking or transfer transactions). They are public and permanent by design and cannot be changed or erased by anyone, including us. They contain a wallet address, not your name or e-mail.",
  "Information we are legally or financially required to keep, such as payment and invoice records (processed by Stripe), for the period the law requires.",
  "A company workspace you share with other people stays for them. If you are its only owner, we will ask whether to transfer or delete it first.",
  "Anonymous, aggregate statistics that no longer identify you.",
];

export default function AccountDeletionPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="relative max-w-3xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">← Back to Inaya Network</a>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Delete your account and data</h1>
        <p className="text-[#8a96ab] text-xs font-mono mb-10">Applies to the Inaya Network web app, the Business Workspace and the Inaya mobile app. Last updated: October 2026</p>

        <div className="space-y-8">
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <h2 className="text-white font-bold text-base mb-3">How to ask</h2>
            <ol className="space-y-2 list-decimal pl-5">{steps.map((t) => <li key={t} className="text-[#94a3b8] text-sm leading-relaxed">{t}</li>)}</ol>
            <p className="mt-4"><a className="inline-block text-sm font-bold text-[#00f2fe] border border-[#00f2fe]/40 rounded-lg px-4 py-2 hover:bg-[#00f2fe]/10" href="mailto:contact@inayanetwork.com?subject=Delete%20my%20Inaya%20account">E-mail a deletion request</a></p>
          </div>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <h2 className="text-white font-bold text-base mb-3">What we delete</h2>
            <ul className="space-y-2">{deleted.map((t) => <li key={t} className="text-[#94a3b8] text-sm leading-relaxed flex gap-2"><span className="text-[#00f2fe] shrink-0">▸</span><span>{t}</span></li>)}</ul>
          </div>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <h2 className="text-white font-bold text-base mb-3">What we cannot delete, and why</h2>
            <ul className="space-y-2">{kept.map((t) => <li key={t} className="text-[#94a3b8] text-sm leading-relaxed flex gap-2"><span className="text-[#00f2fe] shrink-0">▸</span><span>{t}</span></li>)}</ul>
          </div>
        </div>
        <p className="text-[#8a96ab] text-xs mt-10">See also our <a href="/privacy" className="text-[#00f2fe] hover:underline">Privacy Policy</a> and <a href="/terms" className="text-[#00f2fe] hover:underline">Terms of Service</a>.</p>
      </div>
    </div>
  );
}
