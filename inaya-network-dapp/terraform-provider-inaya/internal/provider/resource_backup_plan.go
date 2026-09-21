package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/client"
)

// inaya_backup_plan maps to storageBackupPolicies.js's createBackupPlan/
// getBackupPlan/deleteBackupPlan. No backend Update path exists for a
// plan's own fields (frequency/retention_count/priority), so all of them
// are RequiresReplace -- this provider never invents an update endpoint
// the backend doesn't actually have.
type backupPlanResource struct {
	client *client.Client
}

func NewBackupPlanResource() resource.Resource { return &backupPlanResource{} }

func (r *backupPlanResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_backup_plan"
}

func (r *backupPlanResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A schedule+retention rule under an inaya_backup_policy. Running is handled by Inaya's " +
			"own hourly cron sweep (/api/cron/storage-backup-run) once a plan's next_run_at is due -- this " +
			"resource only declares the schedule, it does not trigger a run itself.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"policy_id": schema.StringAttribute{
				Required:      true,
				Description:   "The inaya_backup_policy.id this plan belongs to.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"frequency": schema.StringAttribute{
				Required:      true,
				Description:   `One of "daily", "weekly", "monthly", "longTerm".`,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"retention_count": schema.Int64Attribute{
				Required:      true,
				Description:   "How many of this plan's snapshots to keep per resource; older ones are deleted (and audited) on each run.",
				PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"priority": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace(), stringplanmodifier.UseStateForUnknown()},
			},
			"health": schema.StringAttribute{
				Computed:    true,
				Description: "HEALTHY/WARNING/DEGRADED/FAILED/PAUSED/UNKNOWN -- reflects real run history, same thresholds as cloudBackupScheduler.js.",
			},
		},
	}
}

type backupPlanModel struct {
	ID             types.String `tfsdk:"id"`
	PolicyID       types.String `tfsdk:"policy_id"`
	Frequency      types.String `tfsdk:"frequency"`
	RetentionCount types.Int64  `tfsdk:"retention_count"`
	Priority       types.String `tfsdk:"priority"`
	Health         types.String `tfsdk:"health"`
}

func (r *backupPlanResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data type", fmt.Sprintf("Expected *client.Client, got: %T", req.ProviderData))
		return
	}
	r.client = c
}

func (r *backupPlanResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan backupPlanModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateBackupPlan(ctx, client.CreateBackupPlanInput{
		PolicyID:       plan.PolicyID.ValueString(),
		Frequency:      plan.Frequency.ValueString(),
		RetentionCount: plan.RetentionCount.ValueInt64(),
		Priority:       plan.Priority.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating backup plan", err.Error())
		return
	}
	// createBackupPlan()'s own return value doesn't include the computed
	// `health` field (only listBackupPlans()/getBackupPlan() attach it) --
	// re-fetch so state isn't left with health="" until the next refresh.
	found, err := r.client.GetBackupPlan(ctx, created.ID)
	if err != nil {
		resp.Diagnostics.AddError("Error reading backup plan after create", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, backupPlanFromAPI(found))...)
}

func (r *backupPlanResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state backupPlanModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := r.client.GetBackupPlan(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading backup plan", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, backupPlanFromAPI(found))...)
}

func (r *backupPlanResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	// Every attribute is RequiresReplace; Update is never actually reached.
}

func (r *backupPlanResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state backupPlanModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteBackupPlan(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error deleting backup plan", err.Error())
	}
}

func (r *backupPlanResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
