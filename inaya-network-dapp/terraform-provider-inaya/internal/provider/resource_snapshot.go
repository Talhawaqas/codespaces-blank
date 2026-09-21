package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/client"
)

// inaya_snapshot maps to storageSnapshots.js's createSnapshot/getSnapshot/
// deleteSnapshot. A snapshot is a point-in-time capture -- there is no
// Update; every attribute other than the computed ones is RequiresReplace,
// and in practice changing source_resource_id is the only way to force a
// new capture (a fresh `terraform apply` with no changes here creates no
// new snapshot -- Terraform's own drift model, not this provider's).
//
// restoreSnapshot()/copySnapshotToResource() are NOT exposed here -- those
// are one-off operational actions, not declarative resource state, and
// don't fit Terraform's CRUD model. Use the Business Workspace UI or the
// REST API directly for those.
type snapshotResource struct {
	client *client.Client
}

func NewSnapshotResource() resource.Resource { return &snapshotResource{} }

func (r *snapshotResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_snapshot"
}

func (r *snapshotResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A point-in-time snapshot of an inaya_storage_resource's current object versions. " +
			"Genuinely incremental at capture time (references existing S3-compat object versions, copies " +
			"no bytes) -- see storageSnapshots.js's module header in the inaya-network-dapp repo.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"source_resource_id": schema.StringAttribute{
				Required:      true,
				Description:   "The inaya_storage_resource.id to snapshot.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"snapshot_type": schema.StringAttribute{
				Computed: true,
			},
			"status": schema.StringAttribute{
				Computed: true,
			},
			"integrity_hash": schema.StringAttribute{
				Computed:    true,
				Description: "SHA-256 over the snapshot's manifest -- independently recomputable, not merely asserted.",
			},
			"created_at": schema.StringAttribute{
				Computed: true,
			},
		},
	}
}

type snapshotModel struct {
	ID               types.String `tfsdk:"id"`
	SourceResourceID types.String `tfsdk:"source_resource_id"`
	SnapshotType     types.String `tfsdk:"snapshot_type"`
	Status           types.String `tfsdk:"status"`
	IntegrityHash    types.String `tfsdk:"integrity_hash"`
	CreatedAt        types.String `tfsdk:"created_at"`
}

func (r *snapshotResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *snapshotResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan snapshotModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateSnapshot(ctx, plan.SourceResourceID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error creating snapshot", err.Error())
		return
	}
	// createSnapshot()'s own return value omits createdAt (only the stored
	// doc, read back via getSnapshot(), has it) -- re-fetch for the same
	// reason as inaya_backup_plan above.
	found, err := r.client.GetSnapshot(ctx, created.ID)
	if err != nil {
		resp.Diagnostics.AddError("Error reading snapshot after create", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, snapshotFromAPI(found))...)
}

func (r *snapshotResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state snapshotModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := r.client.GetSnapshot(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading snapshot", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, snapshotFromAPI(found))...)
}

func (r *snapshotResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	// Every attribute is RequiresReplace; Update is never actually reached.
}

func (r *snapshotResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state snapshotModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteSnapshot(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error deleting snapshot", err.Error())
	}
}

func (r *snapshotResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
