package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/client"
)

// inaya_backup_policy maps to storageBackupPolicies.js's createBackupPolicy/
// getBackupPolicy/setBackupPolicyEnabled/deleteBackupPolicy. `enabled` is
// the one real Update path; name/tag_selector have no backend update
// route and are RequiresReplace.
type backupPolicyResource struct {
	client *client.Client
}

func NewBackupPolicyResource() resource.Resource { return &backupPolicyResource{} }

func (r *backupPolicyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_backup_policy"
}

func (r *backupPolicyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Selects inaya_storage_resource resources by tag for automated, retained snapshotting via one or more inaya_backup_plan children.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"tag_selector": schema.MapAttribute{
				ElementType:   types.StringType,
				Optional:      true,
				Description:   "Only inaya_storage_resource resources whose tags match every key/value here are protected by this policy.",
				PlanModifiers: []planmodifier.Map{mapplanmodifier.RequiresReplace()},
			},
			"notification_policy": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				Description:   `"onFailure" (default), "always", or "never".`,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace(), stringplanmodifier.UseStateForUnknown()},
			},
			"enabled": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Pauses/resumes the policy. This is the one attribute Update actually changes in the backend.",
			},
		},
	}
}

type backupPolicyModel struct {
	ID                 types.String `tfsdk:"id"`
	Name               types.String `tfsdk:"name"`
	TagSelector        types.Map    `tfsdk:"tag_selector"`
	NotificationPolicy types.String `tfsdk:"notification_policy"`
	Enabled            types.Bool   `tfsdk:"enabled"`
}

func (r *backupPolicyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *backupPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan backupPolicyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	selector := map[string]string{}
	if !plan.TagSelector.IsNull() {
		resp.Diagnostics.Append(plan.TagSelector.ElementsAs(ctx, &selector, false)...)
	}

	created, err := r.client.CreateBackupPolicy(ctx, client.CreateBackupPolicyInput{
		Name:               plan.Name.ValueString(),
		TagSelector:        selector,
		NotificationPolicy: plan.NotificationPolicy.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating backup policy", err.Error())
		return
	}

	// A new policy is always created enabled; honor an explicit enabled=false in config.
	if !plan.Enabled.IsNull() && !plan.Enabled.ValueBool() {
		if err := r.client.SetBackupPolicyEnabled(ctx, created.ID, false); err != nil {
			resp.Diagnostics.AddError("Error disabling newly-created backup policy", err.Error())
			return
		}
		created.Enabled = false
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, backupPolicyFromAPI(ctx, created, &resp.Diagnostics))...)
}

func (r *backupPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state backupPolicyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := r.client.GetBackupPolicy(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading backup policy", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, backupPolicyFromAPI(ctx, found, &resp.Diagnostics))...)
}

func (r *backupPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state backupPolicyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if !plan.Enabled.Equal(state.Enabled) {
		if err := r.client.SetBackupPolicyEnabled(ctx, state.ID.ValueString(), plan.Enabled.ValueBool()); err != nil {
			resp.Diagnostics.AddError("Error updating backup policy enabled state", err.Error())
			return
		}
	}

	found, err := r.client.GetBackupPolicy(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading backup policy after update", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, backupPolicyFromAPI(ctx, found, &resp.Diagnostics))...)
}

func (r *backupPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state backupPolicyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteBackupPolicy(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error deleting backup policy", err.Error())
	}
}

func (r *backupPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
