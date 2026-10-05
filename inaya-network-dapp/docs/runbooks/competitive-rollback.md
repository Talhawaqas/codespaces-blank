# Rollback and staged rollout (Competitive Expansion SOW section 55)

Every capability added by the Competitive Expansion SOW is **additive** (new collections, new optional fields, new routes) and sits behind a `FEATURE_*` flag that is **off by default**. Rolling back is therefore a switch, not a data operation.

## Switches, from narrowest to widest

1. **One organization.** An owner or administrator turns the feature off in the organization's beta-features panel (or an operator unsets `features.FEATURE_X` on the organization document). Effect: that organization's routes for the feature return 404; its data stays where it is.
2. **Everyone.** Set the environment variable `FEATURE_X=off` and redeploy. This overrides every organization and also stops an organization from switching the feature back on. Remove the variable to return to per-organization control. `FEATURE_X=on` forces a feature on for everyone and should be used only deliberately.
3. **A single scheduled job.** Remove the job's entry from `vercel.json` `crons` and redeploy. Each job runs through `withJobRun` (`src/lib/jobs/run.js`), so a job already running finishes or is marked stale after 15 minutes; nothing is left half-executed that the next run cannot pick up.

## Check before and after

```bash
node --env-file=.env.local --import ./test/_next-loader.mjs scripts/competitive-migrate.mjs
```

The dry run reads only. It reports every collection the new modules use (exists, document count, index count), each feature flag's environment state, and how many organizations have opted in. `--apply` creates the indexes ahead of first use; it never drops anything.

## What a rollback does not undo

- **Data stays.** Messages, notes, shares, classification history, gateway records, compliance status and evidence, and key configuration written while a feature was on remain in their collections. Turning a feature back on shows them again. Deleting them is a separate, deliberate step that is not part of rollback.
- **Customer-managed keys.** Turning the feature off does not unwrap data keys. If an organization moved to a customer-managed key, the wrapped data key stays wrapped under that key; switching the provider back to the platform key is done through the key configuration (owner action, re-wrap), not by a flag. Do not revoke a customer key while objects depend on it.
- **Chat.** Encrypted conversations are stored as ciphertext; switching the feature off hides the surfaces but removes nothing, and no content is readable by the server either way.
- **Audit.** Audit entries already written (including anchors for gateway audit) are part of the tamper-evident chain and are not removed.

## Staged rollout order used in practice

1. Deploy with every flag off (the default). Existing behaviour is unchanged.
2. Run the dry-run check above; then `--apply`.
3. Enable one internal organization per feature; run the feature's test file and the browser checks listed in `docs/competitive-expansion-final-verification.md`.
4. Widen to selected organizations. Watch `/api/orgs/metrics` gauges and `job_runs` for failures.
5. Only then consider `FEATURE_X=on` platform-wide.
