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

// inaya_vpc maps to a real Linux bridge + nftables default-drop forward
// chain on a node (Sovereign Infrastructure Fabric SOW, Phase 4, ADR-002:
// Linux bridge + nftables, not OVN, for this phase). See
// docs/infrastructure/adr-002-network.md in inaya-network-dapp.
type vpcResource struct {
	client *client.Client
}

func NewVpcResource() resource.Resource { return &vpcResource{} }

func (r *vpcResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_vpc"
}

func (r *vpcResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A real Linux bridge + default-drop nftables forward chain on a node you control. " +
			"Not OVN -- see this provider's docs for why.",
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
			"cidr": schema.StringAttribute{
				Required:      true,
				Description:   "IPv4 CIDR for the bridge's own address, e.g. 10.77.0.1/24.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "Real observed state: CREATING, AVAILABLE, DELETING, DELETED, FAILED.",
			},
		},
	}
}

type vpcModel struct {
	ID        types.String `tfsdk:"id"`
	ClusterID types.String `tfsdk:"cluster_id"`
	NodeID    types.String `tfsdk:"node_id"`
	Cidr      types.String `tfsdk:"cidr"`
	Status    types.String `tfsdk:"status"`
}

func vpcFromAPI(v *client.Vpc) vpcModel {
	return vpcModel{
		ID:        types.StringValue(v.VpcID),
		ClusterID: types.StringValue(v.ClusterID),
		NodeID:    types.StringValue(v.NodeID),
		Cidr:      types.StringValue(v.Cidr),
		Status:    types.StringValue(v.Status),
	}
}

func (r *vpcResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *vpcResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan vpcModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateVpc(ctx, client.CreateVpcInput{
		ClusterID: plan.ClusterID.ValueString(),
		NodeID:    plan.NodeID.ValueString(),
		Cidr:      plan.Cidr.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating VPC", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, vpcFromAPI(created))...)
}

func (r *vpcResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state vpcModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	found, err := r.client.GetVpc(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading VPC", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, vpcFromAPI(found))...)
}

func (r *vpcResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan vpcModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *vpcResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state vpcModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteVpc(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error deleting VPC", err.Error())
	}
}

func (r *vpcResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
