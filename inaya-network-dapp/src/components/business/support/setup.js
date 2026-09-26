"use client";

// Support console: "Portal & sharing". The entry point for administrators to reach the customer portal, a checklist
// that shows what is left to switch on, the kit for telling customers about it (link, QR code, email signature,
// website button) and a live status of email, virus scanning and single sign-on. Everything here reads real server state.

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useLoad, useAction, Card, Note, Err, Btn, Pill } from "../nas/ui";
import { q, post } from "./helpers";

const Step = ({ done, title, hint, action }) => (
  <li className="flex flex-wrap items-start gap-3 py-2">
    <span aria-hidden="true" className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${done ? "border-emerald-400 text-emerald-400" : "border-white/20 text-[var(--inaya-text-muted)]"}`}>{done ? "✓" : ""}</span>
    <div className="min-w-[12rem] flex-1"><div className="text-sm font-medium">{title} <span className="sr-only">{done ? "(done)" : "(to do)"}</span></div><div className="text-xs text-[var(--inaya-text-muted)]">{hint}</div></div>
    {!done && action}
  </li>
);

function CopyButton({ text, label = "Copy" }) {
  const [ok, setOk] = useState(false);
  return <Btn small onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1800); } catch { window.prompt("Copy this:", text); } }}>{ok ? "Copied" : label}</Btn>;
}

export function PortalPanel({ orgId, has, goTab }) {
  const status = useLoad(has("admin_settings") ? `/api/orgs/support/settings/status?${q(orgId)}` : null);
  const settings = useLoad(`/api/orgs/support/settings?${q(orgId)}`);
  const agents = useLoad(`/api/orgs/support/agents?${q(orgId)}`);
  const kb = useLoad(`/api/orgs/support/kb?${q(orgId, "&status=PUBLISHED")}`);
  const [qr, setQr] = useState("");
  const st = settings.data?.settings;
  const url = status.data?.portalUrl || (st?.portalSlug ? `${window.location.origin}/portal/${st.portalSlug}` : "");
  useEffect(() => { if (url) QRCode.toDataURL(url, { margin: 1, width: 220 }).then(setQr).catch(() => setQr("")); }, [url]);
  const test = useAction();
  const s = status.data;
  const portalOn = !!(st?.portalEnabled && st?.portalSlug);
  const agentCount = (agents.data?.agents || []).length;
  const articles = (kb.data?.articles || []).length;
  const signature = url ? `Need help? Open a request or search our help articles: ${url}` : "";
  const button = url ? `<a href="${url}" style="display:inline-block;padding:10px 18px;background:#1f4fd8;color:#fff;border-radius:8px;text-decoration:none;font-family:sans-serif">Get support</a>` : "";
  const nextTab = (tab) => <Btn small onClick={() => goTab(tab)}>Open</Btn>;

  return (
    <div className="space-y-4">
      <Card title="Your customer portal" right={portalOn ? <a className="rounded border border-[var(--inaya-accent)] px-3 py-1 text-xs font-medium text-[var(--inaya-accent)]" href={url} target="_blank" rel="noreferrer">Open the portal ↗</a> : null}>
        {portalOn ? (
          <div className="space-y-2">
            <p className="text-sm">Customers reach it here. They sign in with a one-time link{st?.sso?.enabled ? ` or ${st.sso.label}` : ""}, raise requests, follow them, and read your help articles.</p>
            <div className="flex flex-wrap items-center gap-2"><code className="break-all rounded border border-white/10 px-2 py-1 text-xs">{url}</code><CopyButton text={url} label="Copy link" /></div>
            <Note>{st.signup === "open" ? "Anyone with a working email can sign in and submit a request (they are added to your CRM as a lead)." : "Only people already in your CRM contacts can sign in. Add a customer as a CRM contact and they can use the portal straight away."}</Note>
          </div>
        ) : <Note tone="warn">The portal is switched off. Choose a portal address and switch it on in <button type="button" className="underline" onClick={() => goTab("settings")}>Settings → Portal &amp; email</button>. Customers cannot reach it until then.</Note>}
      </Card>

      <Card title="Set-up checklist">
        <ul className="divide-y divide-white/5" aria-label="Set-up checklist">
          <Step done={portalOn} title="Switch on the portal" hint="Choose an address such as acme-support and turn it on." action={nextTab("settings")} />
          <Step done={agentCount > 1 || agentCount === 1} title={`Give your team access (${agentCount} with support access)`} hint="Owners and admins always have it. Add agents or managers under Settings → Agents." action={nextTab("settings")} />
          <Step done={articles > 0} title={`Publish help articles (${articles} published)`} hint="The portal search and the AI assistant answer only from published articles." action={nextTab("knowledge")} />
          <Step done={!!s?.email?.outbound?.configured} title="Outbound email works" hint="Sign-in links and ticket updates are emailed. Use the test below to confirm." action={null} />
          <Step done={!!(s?.email?.inbound?.resendWebhookConfigured || s?.email?.inbound?.organizationRelayEnabled)} title="Reply-by-email (optional)" hint="Customers can answer ticket emails and have it land in the right ticket." action={null} />
        </ul>
      </Card>

      {url && portalOn && (
        <Card title="Tell your customers">
          <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
            {qr && <img src={qr} alt={`QR code for ${url}`} width={160} height={160} className="rounded border border-white/10 bg-white p-1" />}
            <div className="space-y-3 text-sm">
              <div><div className="text-xs text-[var(--inaya-text-muted)]">Email signature</div><div className="flex flex-wrap items-center gap-2"><code className="break-all text-xs">{signature}</code><CopyButton text={signature} /></div></div>
              <div><div className="text-xs text-[var(--inaya-text-muted)]">Button for your website</div><div className="flex flex-wrap items-center gap-2"><code className="break-all text-xs">{button}</code><CopyButton text={button} /></div></div>
              <div><div className="text-xs text-[var(--inaya-text-muted)]">Customers who do not know the address can also go to</div><div className="flex flex-wrap items-center gap-2"><code className="text-xs">{`${window.location.origin}/support/${st.portalSlug}`}</code><CopyButton text={`${window.location.origin}/support/${st.portalSlug}`} /></div></div>
            </div>
          </div>
        </Card>
      )}

      {s && (
        <Card title="What is switched on">
          <ul className="space-y-2 text-sm">
            <li className="flex flex-wrap items-center gap-2"><Pill value={s.email.outbound.configured ? "OK" : "WARNING"} label={s.email.outbound.configured ? "Outbound email ready" : "Outbound email off"} /><span className="text-xs text-[var(--inaya-text-muted)]">{s.email.outbound.configured ? `Sends as ${s.email.outbound.from || "the default sender"}.` : "Set RESEND_API_KEY on the server."}</span>
              {s.email.outbound.configured && <Btn small busy={test.busy} onClick={() => test.run(() => post(orgId, "settings/test-email"))}>Send a test to me</Btn>}</li>
            {test.result?.sent && <li className="text-xs text-emerald-400" role="status">Test email sent to {test.result.to}. Check your inbox.</li>}
            <li className="flex flex-wrap items-center gap-2"><Pill value={s.email.inbound.resendWebhookConfigured ? "OK" : "PENDING"} label={s.email.inbound.resendWebhookConfigured ? "Reply-by-email ready" : "Reply-by-email not set up"} /><span className="text-xs text-[var(--inaya-text-muted)]">{s.email.inbound.replyAddress ? `Customers reply to ${s.email.inbound.replyAddress}.` : "No reply address yet: set your support address in Settings, or ask the platform operator for an inbound domain."}</span></li>
            <li className="flex flex-wrap items-center gap-2"><Pill value={s.scanning.engines.length ? "OK" : "ATTENTION"} label={s.scanning.engines.length ? `Virus scanning: ${s.scanning.engines.join(" + ")}` : "Virus scanning: built-in only"} /><span className="text-xs text-[var(--inaya-text-muted)]">{s.scanning.note}</span></li>
            <li className="flex flex-wrap items-center gap-2"><Pill value={s.sso.enabled ? "OK" : "PENDING"} label={s.sso.enabled ? "Single sign-on on" : "Single sign-on off"} /><span className="text-xs text-[var(--inaya-text-muted)]">Configure it in Settings → Sign-in &amp; security.</span></li>
            <li className="flex flex-wrap items-center gap-2"><Pill value="OK" label={`Attachments up to ${Math.round(s.attachments.maxBytes / 1048576)} MB`} /></li>
          </ul>
          <Err error={test.error} />
        </Card>
      )}
    </div>
  );
}
