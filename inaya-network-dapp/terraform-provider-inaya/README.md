# terraform-provider-inaya

A real Terraform provider for Inaya's storage control plane, built on
`terraform-plugin-framework`. This is the workstream `docs/ibm-vpc-storage-expansion-report.md`
(IBM Cloud VPC Storage Gap Expansion SOW) explicitly deferred as "a separate,
multi-week Go effort" — it's now built, once a real Go toolchain was
available in this environment.

## Status: local-only, not yet published to the Terraform Registry

This provider is functional and tested against a real running Inaya
deployment (see [Testing](#testing) below), but it has **not** been
published to `registry.terraform.io`. Using it today means either:

1. Building it locally (`go build -o terraform-provider-inaya .`) and
   pointing Terraform at the binary with `dev_overrides` in your
   `~/.terraformrc` (see below), or
2. Publishing it to the Terraform Registry (requires a public GitHub repo
   under `terraform-provider-inaya` naming, GPG-signed releases via
   GoReleaser, and registry approval) — not done as part of this pass.

## What this manages, and what it honestly does not

| Resource | Backend function(s) | Real physical capability |
|---|---|---|
| `inaya_storage_resource` | `storageResources.js` | A **logical**, taggable, resizable container backed by a real S3-compatible bucket. `type = "volume"` is never a real attachable block device (Inaya has no compute/VM layer); `type = "fileShare"` is never a real mountable NFS export. See the resource's own `physical_capability` computed attribute and `docs/ibm-vpc-storage-expansion-report.md` in the main repo. |
| `inaya_snapshot` | `storageSnapshots.js` | A real point-in-time capture, genuinely incremental at capture time (references existing object versions, copies no bytes). No `fast_restore` — restoring is always a normal copy-forward restore. |
| `inaya_backup_policy` | `storageBackupPolicies.js` | A real tag-selector-scoped policy. |
| `inaya_backup_plan` | `storageBackupPolicies.js` | A real schedule + retention rule. Running happens via Inaya's own hourly cron sweep once a plan is due — this resource only declares the schedule, it never triggers a run itself. |

**Not exposed by this provider** (all real backend capabilities, just not
a fit for Terraform's declarative CRUD model): volume attach/detach
(`attachVolume`/`detachVolume` — an imperative reservation action, not
resource state), file-share mount targets, consistency groups, cross-region
snapshot copy, cross-organization snapshot sharing, and manually triggering
a backup plan run. Use the Business Workspace UI or the REST API directly
for those.

## Authentication

Every request needs an Inaya org API key (`Authorization: Bearer <key>`),
created via the existing `api-keys.js` / Business Workspace API Keys flow.
Set it via the provider's `api_key` attribute or the `INAYA_API_KEY`
environment variable. The key resolves to exactly one org server-side —
nothing in this provider or the API surface it calls can point a request
at a different org than the key's own (see
`src/lib/api-keys.js`'s `requireApiKey()` in the main repo).

## Local development

```bash
go build -o terraform-provider-inaya .
```

Add to `~/.terraformrc` (or `%APPDATA%\terraform.rc` on Windows) so
Terraform uses your local binary instead of trying to fetch this from the
registry:

```hcl
provider_installation {
  dev_overrides {
    "talhawaqas/inaya" = "/absolute/path/to/terraform-provider-inaya"
  }
  direct {}
}
```

Then, in a directory with a `.tf` config (see `examples/main.tf`):

```bash
export INAYA_ENDPOINT=http://localhost:3000
export INAYA_API_KEY=inaya_...
terraform plan
terraform apply
```

No `terraform init` is needed for the overridden provider — Terraform will
print a warning that dev overrides are active and use the local binary
directly.

## Testing

Every resource's full create → read → update (where one exists) → delete
cycle was run against a real local Inaya dev server (`npm run dev`) with a
real API key and real MongoDB-backed state — not a mocked or dry-run test.
Specifically verified:

- `terraform apply` creating all four resource types in one config, with
  real cross-resource references (`inaya_snapshot.source_resource_id =
  inaya_storage_resource.vol.id`, `inaya_backup_plan.policy_id =
  inaya_backup_policy.prod.id`).
- A no-op `terraform plan` after apply reporting zero drift.
- `capacity_gb` increasing in place (a real `PATCH`, not a resource
  replacement) — `0 to add, 1 to change, 0 to destroy`.
- Attempting to decrease `capacity_gb` failing with the backend's real
  "Capacity decrease is not supported" error, surfaced as a Terraform
  diagnostic rather than silently ignored.
- `terraform destroy` removing all four resources cleanly.

One real bug was found and fixed during this testing: `inaya_backup_plan`'s
computed `health` attribute (and `inaya_snapshot`'s `created_at`) were
correct after a `terraform plan`/refresh but came back empty immediately
after `terraform apply`, because `createBackupPlan()`/`createSnapshot()`'s
own return values don't include those fields (only the list/get functions
compute or return them). Fixed by having `Create()` re-fetch via the
corresponding `Get` call before writing state, for every resource.

No automated Go test suite was written for this pass (the coverage above
is real, manual, end-to-end verification against a live server) — a
`resource.Test`-based acceptance test suite (Terraform's standard testing
framework) would be a reasonable next step if this provider sees ongoing use.
