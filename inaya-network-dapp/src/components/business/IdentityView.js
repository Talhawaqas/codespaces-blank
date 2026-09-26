"use client";

// src/components/business/IdentityView.js
//
// Identity Integration SOW section 44: Business Workspace > Identity & Access. Providers, mappings, lifecycle (with evidence), revocation,
// drift, reviews, temporary access, orphans, bulk jobs, MSP, credentials, outbound events, dry run. Real calls to
// /api/integrations/identity/*; the server enforces every rule, and no figure is computed or invented in the browser.

import { useState } from "react";
import EmptyState from "../EmptyState";
import { Note } from "./nas/ui";
import { OverviewPanel, ProvidersPanel, MappingsPanel, LifecyclePanel, RevocationPanel, DriftPanel, DryRunPanel, PeoplePanel } from "./identity/panels";
import { ReviewsPanel, TemporaryPanel, OrphansPanel, JobsPanel, MspPanel, CredentialsPanel, EventsPanel } from "./identity/panels2";

const TABS = [
  ["overview", "Overview"], ["providers", "Providers"], ["mappings", "Mappings"], ["lifecycle", "Lifecycle"], ["revocation", "Revocation"], ["people", "People"], ["drift", "Drift"],
  ["reviews", "Access reviews"], ["temporary", "Temporary access"], ["orphans", "Orphans"], ["jobs", "Bulk jobs"], ["dryrun", "Dry run"], ["msp", "MSP"], ["credentials", "Credentials"], ["events", "Events out"],
];

export default function IdentityView({ orgId, canManage }) {
  const [tab, setTab] = useState("overview");
  if (!canManage) return <EmptyState title="No access to Identity & Access" description="Only an organization owner or admin can manage identity integrations." />;
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Identity &amp; Access</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Connect Entra ID, Active Directory (through Rewst or an RMM), HR and PSA systems. Joiners, movers and leavers change Inaya access automatically, and a leaver is cut off at once.
          Inaya stays the authority: every change is verified, audited and recorded as evidence.</p>
      </header>
      <nav aria-label="Identity sections" className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${tab === id ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </nav>
      {tab === "overview" && <OverviewPanel orgId={orgId} />}
      {tab === "providers" && <ProvidersPanel orgId={orgId} canManage={canManage} />}
      {tab === "mappings" && <MappingsPanel orgId={orgId} canManage={canManage} />}
      {tab === "lifecycle" && <LifecyclePanel orgId={orgId} canManage={canManage} />}
      {tab === "revocation" && <RevocationPanel orgId={orgId} canManage={canManage} />}
      {tab === "people" && <PeoplePanel orgId={orgId} canManage={canManage} />}
      {tab === "drift" && <DriftPanel orgId={orgId} canManage={canManage} />}
      {tab === "reviews" && <ReviewsPanel orgId={orgId} canManage={canManage} />}
      {tab === "temporary" && <TemporaryPanel orgId={orgId} canManage={canManage} />}
      {tab === "orphans" && <OrphansPanel orgId={orgId} canManage={canManage} />}
      {tab === "jobs" && <JobsPanel orgId={orgId} canManage={canManage} />}
      {tab === "dryrun" && <DryRunPanel orgId={orgId} />}
      {tab === "msp" && <MspPanel orgId={orgId} canManage={canManage} />}
      {tab === "credentials" && <CredentialsPanel orgId={orgId} canManage={canManage} />}
      {tab === "events" && <EventsPanel orgId={orgId} canManage={canManage} />}
      <Note>Nothing here is simulated. States, counts and findings come from recorded runs, events and revocations. Directory and Rewst connections are labelled VERIFIED / UNVERIFIED in the documentation.</Note>
    </div>
  );
}
