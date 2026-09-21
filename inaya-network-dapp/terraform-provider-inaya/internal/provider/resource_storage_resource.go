package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/numberplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/client"
)

// inaya_storage_resource maps to storageResources.js's createStorageResource/
// getStorageResource/expandStorageResourceCapacity/deleteStorageResource.
//
// HONESTY NOTE (read before assuming this is a real attachable disk):
// `type = "volume"` is a logical, taggable, resizable container backed by a
// real Inaya S3-compatible bucket -- Inaya has no compute/VM layer, so
// there is no physical device for a volume to attach to. `type =
// "fileShare"` is the same kind of container with declared (never
// physically mountable) mount-target bookkeeping. See
// docs/ibm-vpc-storage-expansion-report.md in the inaya-network-dapp repo.
// The `physical_capability` computed attribute states this plainly on
// every resource this provider manages.
type storageResourceResource struct {
	client *client.Client
}

func NewStorageResourceResource() resource.Resource { return &storageResourceResource{} }

func (r *storageResourceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_storage_resource"
}

func (r *storageResourceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A logical Inaya storage resource -- a volume or a file share. Not a physical block " +
			"device or a mountable NFS export; see `physical_capability`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"type": schema.StringAttribute{
				Required:      true,
				Description:   `"volume" or "fileShare".`,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"region": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "A logical label, not a physical geography -- Inaya's pinning providers don't route by real region today.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace(), stringplanmodifier.UseStateForUnknown()},
			},
			"capacity_gb": schema.NumberAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Requested capacity in GB. Increase-only -- decreasing this value is rejected by the backend, so Terraform plans will fail rather than silently no-op a shrink.",
				PlanModifiers: []planmodifier.Number{numberplanmodifier.UseStateForUnknown()},
			},
			"tags": schema.MapAttribute{
				ElementType:   types.StringType,
				Optional:      true,
				Description:   "Up to 10 tags. No update path exists in the backend, so changing tags replaces the resource.",
				PlanModifiers: []planmodifier.Map{mapplanmodifier.RequiresReplace()},
			},
			"status": schema.StringAttribute{
				Computed: true,
			},
			"physical_capability": schema.StringAttribute{
				Computed:    true,
				Description: "States plainly what this resource can and cannot physically do -- see this resource's own docs.",
			},
			"backing_bucket": schema.StringAttribute{
				Computed:    true,
				Description: "The real Inaya S3-compatible bucket this resource's bytes actually live in.",
			},
		},
	}
}

type storageResourceModel struct {
	ID                 types.String `tfsdk:"id"`
	Type               types.String `tfsdk:"type"`
	Name               types.String `tfsdk:"name"`
	Region             types.String `tfsdk:"region"`
	CapacityGB         types.Number `tfsdk:"capacity_gb"`
	Tags               types.Map    `tfsdk:"tags"`
	Status             types.String `tfsdk:"status"`
	PhysicalCapability types.String `tfsdk:"physical_capability"`
	BackingBucket      types.String `tfsdk:"backing_bucket"`
}

func (r *storageResourceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *storageResourceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan storageResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	tags := map[string]string{}
	if !plan.Tags.IsNull() {
		resp.Diagnostics.Append(plan.Tags.ElementsAs(ctx, &tags, false)...)
	}

	var capacity float64
	if !plan.CapacityGB.IsNull() {
		capacity, _ = plan.CapacityGB.ValueBigFloat().Float64()
	}

	created, err := r.client.CreateStorageResource(ctx, client.CreateStorageResourceInput{
		Type:     plan.Type.ValueString(),
		Name:     plan.Name.ValueString(),
		Region:   plan.Region.ValueString(),
		Capacity: capacity,
		Tags:     tags,
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating storage resource", err.Error())
		return
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, storageResourceFromAPI(ctx, created, &resp.Diagnostics))...)
}

func (r *storageResourceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state storageResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	found, err := r.client.GetStorageResource(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading storage resource", err.Error())
		return
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, storageResourceFromAPI(ctx, found, &resp.Diagnostics))...)
}

func (r *storageResourceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state storageResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Every other attribute is RequiresReplace -- the only real Update path
	// is capacity, and only upward (the backend rejects a decrease).
	if !plan.CapacityGB.Equal(state.CapacityGB) {
		newCap, _ := plan.CapacityGB.ValueBigFloat().Float64()
		if err := r.client.ExpandStorageResourceCapacity(ctx, state.ID.ValueString(), newCap); err != nil {
			resp.Diagnostics.AddError("Error expanding storage resource capacity", err.Error())
			return
		}
	}

	found, err := r.client.GetStorageResource(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading storage resource after update", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, storageResourceFromAPI(ctx, found, &resp.Diagnostics))...)
}

func (r *storageResourceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state storageResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteStorageResource(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError("Error deleting storage resource", err.Error())
	}
}

func (r *storageResourceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
