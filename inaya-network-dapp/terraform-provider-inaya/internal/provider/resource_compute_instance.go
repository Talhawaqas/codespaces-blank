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

// inaya_compute_instance maps to a real QEMU/KVM virtual machine (Sovereign
// Infrastructure Fabric SOW, Phase 2). Creation is asynchronous -- the
// control plane queues the request, the node daemon executes it on its
// next poll cycle. `state` reflects the control plane's real observed
// state (PROVISIONING/RUNNING/STOPPED/ERROR/...), never an assumed value.
type computeInstanceResource struct {
	client *client.Client
}

func NewComputeInstanceResource() resource.Resource { return &computeInstanceResource{} }

func (r *computeInstanceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_compute_instance"
}

func (r *computeInstanceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A real QEMU/KVM virtual machine on a node you control. Creation is asynchronous: " +
			"the node daemon executes it on its own poll cycle, so `state` may read PROVISIONING for a " +
			"short time after apply before a subsequent refresh shows RUNNING.",
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
				Description:   "The node this instance runs on. No scheduler indirection at this layer -- pass an explicit node_id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"vcpu": schema.Int64Attribute{
				Required:      true,
				PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"memory_mib": schema.Int64Attribute{
				Required:      true,
				PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"volume_id": schema.StringAttribute{
				Optional:      true,
				Description:   "An existing inaya_compute_volume to attach as the boot/data disk.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"vpc_id": schema.StringAttribute{
				Optional:      true,
				Description:   "An existing inaya_vpc to attach a real network interface into.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"state": schema.StringAttribute{
				Computed:    true,
				Description: "Real observed state from the control plane: PROVISIONING, RUNNING, STOPPED, ERROR, TERMINATED, etc.",
			},
		},
	}
}

type computeInstanceModel struct {
	ID        types.String `tfsdk:"id"`
	ClusterID types.String `tfsdk:"cluster_id"`
	NodeID    types.String `tfsdk:"node_id"`
	Name      types.String `tfsdk:"name"`
	Vcpu      types.Int64  `tfsdk:"vcpu"`
	MemoryMiB types.Int64  `tfsdk:"memory_mib"`
	VolumeID  types.String `tfsdk:"volume_id"`
	VpcID     types.String `tfsdk:"vpc_id"`
	State     types.String `tfsdk:"state"`
}

func computeInstanceFromAPI(inst *client.ComputeInstance) computeInstanceModel {
	m := computeInstanceModel{
		ID:        types.StringValue(inst.InstanceID),
		ClusterID: types.StringValue(inst.ClusterID),
		NodeID:    types.StringValue(inst.NodeID),
		Name:      types.StringValue(inst.Name),
		Vcpu:      types.Int64Value(inst.Vcpu),
		MemoryMiB: types.Int64Value(inst.MemoryMiB),
		State:     types.StringValue(inst.State),
	}
	if inst.VolumeID != "" {
		m.VolumeID = types.StringValue(inst.VolumeID)
	} else {
		m.VolumeID = types.StringNull()
	}
	if inst.VpcID != "" {
		m.VpcID = types.StringValue(inst.VpcID)
	} else {
		m.VpcID = types.StringNull()
	}
	return m
}

func (r *computeInstanceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *computeInstanceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan computeInstanceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateComputeInstance(ctx, client.CreateComputeInstanceInput{
		ClusterID: plan.ClusterID.ValueString(),
		NodeID:    plan.NodeID.ValueString(),
		Name:      plan.Name.ValueString(),
		Vcpu:      plan.Vcpu.ValueInt64(),
		MemoryMiB: plan.MemoryMiB.ValueInt64(),
		VolumeID:  plan.VolumeID.ValueString(),
		VpcID:     plan.VpcID.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating compute instance", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, computeInstanceFromAPI(created))...)
}

func (r *computeInstanceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state computeInstanceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := r.client.GetComputeInstance(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading compute instance", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, computeInstanceFromAPI(found))...)
}

func (r *computeInstanceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	// Every attribute is RequiresReplace -- there is no real in-place
	// update path on the backend yet (no resize-running-VM capability).
	var plan computeInstanceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *computeInstanceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state computeInstanceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.TerminateComputeInstance(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error terminating compute instance", err.Error())
	}
}

func (r *computeInstanceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
