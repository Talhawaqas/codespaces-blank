"use client";

import { useState } from "react";
import { useAction, Card, Note, Err, Btn, Select } from "../nas/ui";
import { send } from "./helpers";

const BOOLS = [
  ["removeObsoleteOnMove", "A mover loses external access the new state no longer justifies"],
  ["revokeCredentialsCreatedByUser", "Revoke API keys and storage credentials created by a leaver"],
  ["revokeSharesCreatedByUser", "Revoke share links created by a leaver"],
  ["requireApprovalForPrivileged", "Privileged access (admin) waits for a human approval"],
  ["autoRevokeDisabledOnDrift", "Reconciliation revokes people who are disabled at the source (otherwise it only reports)"],
  ["employeeIdAuthoritative", "Treat employee id as an authoritative key"],
  ["notify", "Notify administrators of every lifecycle change"],
];

export function PolicyEditor({ orgId, provider, onSaved }) {
  const [p, setP] = useState(provider.policy);
  const act = useAction(onSaved);
  return (
    <Card title={`Policy: ${provider.name}`}>
      <Err error={act.error} />
      <div className="grid gap-3 md:grid-cols-3">
        <Select label="Link by email" value={p.emailLinking} onChange={(v) => setP({ ...p, emailLinking: v })} options={[{ value: "exact_unique", label: "Only when exactly one match (controlled fallback)" }, { value: "off", label: "Never (immutable id only)" }]} />
        <Select label="Enable event after revocation" value={p.restoreOnEnable} onChange={(v) => setP({ ...p, restoreOnEnable: v })} options={[{ value: "manual_review", label: "Wait for a person to approve" }, { value: "auto", label: "Restore automatically" }, { value: "never", label: "Never restore from an event" }]} />
        <Select label="Sign-in sessions on revocation" value={p.sessionRevocation} onChange={(v) => setP({ ...p, sessionRevocation: v })} options={[{ value: "if_no_other_active_membership", label: "Only if no other active organization" }, { value: "always", label: "Always" }]} />
      </div>
      <div className="grid gap-1 md:grid-cols-2">
        {BOOLS.map(([k, label]) => (
          <label key={k} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={!!p[k]} onChange={(e) => setP({ ...p, [k]: e.target.checked })} /><span>{label}</span></label>
        ))}
      </div>
      <Btn busy={act.busy} onClick={() => act.run(() => send(orgId, `providers/${provider.providerId}`, { policy: p }, "PATCH"))}>Save policy</Btn>
      <Note>Access removal is never delayed or gated. Only privileged additions go through Controlled Actions.</Note>
    </Card>
  );
}
