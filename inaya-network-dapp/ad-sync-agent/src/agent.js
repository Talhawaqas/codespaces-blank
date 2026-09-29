#!/usr/bin/env node
// ad-sync-agent/src/agent.js
//
// The real, runnable AD sync agent: connects OUT to a real Active
// Directory domain controller over LDAP, and OUT to Inaya's existing
// identity webhook -- never accepts an inbound connection from Inaya,
// matching this SOW's hard security requirement (see
// docs/identity-integration-report.md and the co-founder summary).
//
// Configuration is via environment variables (a real customer runs this
// as a scheduled task/cron/service inside their own network, pointed at
// their own DC and their own Inaya org's provider credentials):
//   AD_LDAP_URL          e.g. ldap://192.168.56.10:389
//   AD_BIND_DN            e.g. CN=Administrator,CN=Users,DC=inayatest,DC=local
//   AD_BIND_PASSWORD
//   AD_BASE_DN             e.g. DC=inayatest,DC=local
//   INAYA_BASE_URL         e.g. http://localhost:3000
//   INAYA_PROVIDER_ID       the provider's Mongo _id (from createProvider)
//   INAYA_SIGNING_SECRET    the provider's signing secret (shown once at creation)
//   AD_SYNC_WATERMARK_FILE  optional, defaults to ./ad-sync-watermark.json
//
// Run once: node src/agent.js
// Run continuously: wrap in the host's own scheduler (cron, Task
// Scheduler, systemd timer) -- this agent does one pull-and-push pass
// and exits; it deliberately does not daemonize or poll on its own, so
// its operating cadence is fully the customer's own choice, auditable
// in their own scheduler rather than hidden inside this process.

import path from "node:path";
import { fetchUsers, fetchHighestCommittedUsn } from "./ldap.js";
import { readWatermark, writeWatermark } from "./watermark.js";
import { pushUser } from "./push.js";

function requireEnv(name, env) {
  const v = env[name];
  if (!v) throw new Error(`${name} is required (see ad-sync-agent/README.md).`);
  return v;
}

/** The engine requires event.tenantId to exactly equal the provider's
 *  own providerTenantId (a real cross-tenant-injection guard). The
 *  standard, correct way to derive an AD domain's DNS name from its own
 *  base DN: "DC=inayatest,DC=local" -> "inayatest.local". AD_TENANT_ID
 *  overrides this for the rare case a provider was registered under a
 *  different identifier than the base DN implies. */
export function deriveTenantId(baseDN, env) {
  if (env.AD_TENANT_ID) return env.AD_TENANT_ID;
  const parts = baseDN.split(",").map((p) => p.trim()).filter((p) => /^DC=/i.test(p)).map((p) => p.replace(/^DC=/i, ""));
  if (parts.length === 0) throw new Error(`Could not derive a tenantId from AD_BASE_DN="${baseDN}" -- set AD_TENANT_ID explicitly.`);
  return parts.join(".");
}

export async function runOnce(env = process.env) {
  const config = {
    url: requireEnv("AD_LDAP_URL", env),
    bindDN: requireEnv("AD_BIND_DN", env),
    bindPassword: requireEnv("AD_BIND_PASSWORD", env),
    baseDN: requireEnv("AD_BASE_DN", env),
    inayaBaseUrl: requireEnv("INAYA_BASE_URL", env),
    providerId: requireEnv("INAYA_PROVIDER_ID", env),
    signingSecret: requireEnv("INAYA_SIGNING_SECRET", env),
    watermarkFile: env.AD_SYNC_WATERMARK_FILE || path.resolve(process.cwd(), "ad-sync-watermark.json"),
  };
  config.tenantId = deriveTenantId(config.baseDN, env);

  const priorWatermark = readWatermark(config.watermarkFile);
  const mode = priorWatermark === undefined ? "full" : "incremental";
  console.log(`[ad-sync-agent] Starting ${mode} sync against ${config.url} base=${config.baseDN}`);

  const users = await fetchUsers({
    url: config.url, bindDN: config.bindDN, bindPassword: config.bindPassword,
    baseDN: config.baseDN, filterUsnFloor: priorWatermark,
  });
  console.log(`[ad-sync-agent] LDAP returned ${users.length} changed user(s).`);

  const results = { pushed: 0, failed: 0, errors: [] };
  for (const user of users) {
    try {
      const r = await pushUser({ inayaBaseUrl: config.inayaBaseUrl, providerId: config.providerId, signingSecret: config.signingSecret, tenantId: config.tenantId, rawAdUser: user });
      if (r.httpStatus >= 200 && r.httpStatus < 300) {
        results.pushed += 1;
        console.log(`[ad-sync-agent] Pushed ${user.userPrincipalName || user.objectGUID}: ${r.body?.status || r.httpStatus}`);
      } else {
        results.failed += 1;
        results.errors.push({ user: user.userPrincipalName || user.objectGUID, httpStatus: r.httpStatus, body: r.body });
        console.error(`[ad-sync-agent] FAILED ${user.userPrincipalName || user.objectGUID}: HTTP ${r.httpStatus} ${JSON.stringify(r.body)}`);
      }
    } catch (err) {
      results.failed += 1;
      results.errors.push({ user: user.userPrincipalName || user.objectGUID, error: err.message });
      console.error(`[ad-sync-agent] FAILED ${user.userPrincipalName || user.objectGUID}: ${err.message}`);
    }
  }

  // Only advance the watermark past events that were genuinely pushed
  // successfully -- a partial-failure run must not silently skip the
  // failed users on the next incremental pull.
  if (results.failed === 0) {
    const newWatermark = await fetchHighestCommittedUsn({ url: config.url, bindDN: config.bindDN, bindPassword: config.bindPassword });
    if (newWatermark !== undefined) {
      writeWatermark(config.watermarkFile, newWatermark);
      console.log(`[ad-sync-agent] Watermark advanced to uSNChanged=${newWatermark}`);
    }
  } else {
    console.warn(`[ad-sync-agent] ${results.failed} push(es) failed -- watermark NOT advanced, so those users are retried on the next run.`);
  }

  console.log(`[ad-sync-agent] Done. pushed=${results.pushed} failed=${results.failed}`);
  return results;
}

const isMain = process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")));
if (isMain) {
  runOnce().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((err) => {
    console.error(`[ad-sync-agent] Fatal: ${err.message}`);
    process.exit(1);
  });
}
