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

// inaya_compute_volume maps to a real sparse qcow2 file on a node's local
// filesystem (Sovereign Infrastructure Fabric SOW, Phase 3, ADR-004) --
// not the logical, S3-backed inaya_storage_resource above. See
// docs/infrastructure/adr-004-block-storage.md in inaya-network-dapp.
type computeVolumeResource struct {
	client *client.Client
}

func NewComputeVolumeResource() resource.Resource { return &computeVolumeResource{} }

func (r *computeVolumeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_compute_volume"
}

func (r *computeVolumeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A real block volume (sparse qcow2 file) on a node you control, attachable to an inaya_compute_instance.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"cluster_id": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"node_id": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"size_gib": schema.Int64Attribute{
				Required:      true,
				Description:   "1-2048 GiB. No resize path exists yet -- changing this replaces the volume.",
				PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "Real observed state: CREATING, AVAILABLE, IN_USE, DELETING, DELETED, FAILED.",
			},
		},
	}
}

type computeVolumeModel struct {
	ID        types.String `tfsdk:"id"`
	ClusterID types.String `tfsdk:"cluster_id"`
	NodeID    types.String `tfsdk:"node_id"`
	SizeGiB   types.Int64  `tfsdk:"size_gib"`
	Status    types.String `tfsdk:"status"`
}

func computeVolumeFromAPI(v *client.Volume) computeVolumeModel {
	return computeVolumeModel{
		ID:        types.StringValue(v.VolumeID),
		ClusterID: types.StringValue(v.ClusterID),
		NodeID:    types.StringValue(v.NodeID),
		SizeGiB:   types.Int64Value(v.SizeGiB),
		Status:    types.StringValue(v.Status),
	}
}

func (r *computeVolumeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *computeVolumeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan computeVolumeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateVolume(ctx, client.CreateVolumeInput{
		ClusterID: plan.ClusterID.ValueString(),
		NodeID:    plan.NodeID.ValueString(),
		SizeGiB:   plan.SizeGiB.ValueInt64(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating compute volume", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, computeVolumeFromAPI(created))...)
}

func (r *computeVolumeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state computeVolumeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := r.client.GetVolume(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading compute volume", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, computeVolumeFromAPI(found))...)
}

func (r *computeVolumeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan computeVolumeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *computeVolumeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state computeVolumeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteVolume(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error deleting compute volume", err.Error())
	}
}

func (r *computeVolumeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
