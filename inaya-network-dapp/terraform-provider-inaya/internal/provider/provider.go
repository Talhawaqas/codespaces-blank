package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/client"
)

// version is set by GoReleaser/ldflags at build time; "dev" for local builds.
var version = "dev"

func New() provider.Provider {
	return &inayaProvider{}
}

type inayaProvider struct{}

type inayaProviderModel struct {
	Endpoint types.String `tfsdk:"endpoint"`
	APIKey   types.String `tfsdk:"api_key"`
}

func (p *inayaProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "inaya"
	resp.Version = version
}

func (p *inayaProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages Inaya's storage control plane (storage resources/volumes, snapshots, and " +
			"backup policies -- see docs/ibm-vpc-storage-expansion-report.md in the inaya-network-dapp repo " +
			"for what this control plane does and does not physically provision). Talks to the " +
			"/api/public/v1/storage/* REST namespace using an org API key.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Optional: true,
				Description: "Base URL of the Inaya deployment, e.g. https://app.inaya.network or " +
					"http://localhost:3000 for a local dev server. Falls back to the INAYA_ENDPOINT " +
					"environment variable.",
			},
			"api_key": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "An Inaya org API key (see api-keys.js / the Business Workspace's API Keys settings). Falls back to the INAYA_API_KEY environment variable.",
			},
		},
	}
}

func (p *inayaProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var data inayaProviderModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	endpoint := data.Endpoint.ValueString()
	if endpoint == "" {
		endpoint = os.Getenv("INAYA_ENDPOINT")
	}
	if endpoint == "" {
		resp.Diagnostics.AddError(
			"Missing endpoint",
			"Set the provider's `endpoint` attribute or the INAYA_ENDPOINT environment variable to the base URL of your Inaya deployment.",
		)
	}

	apiKey := data.APIKey.ValueString()
	if apiKey == "" {
		apiKey = os.Getenv("INAYA_API_KEY")
	}
	if apiKey == "" {
		resp.Diagnostics.AddError(
			"Missing API key",
			"Set the provider's `api_key` attribute or the INAYA_API_KEY environment variable to an Inaya org API key.",
		)
	}

	if resp.Diagnostics.HasError() {
		return
	}

	c := client.New(endpoint, apiKey)
	resp.ResourceData = c
	resp.DataSourceData = c
}

func (p *inayaProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewStorageResourceResource,
		NewSnapshotResource,
		NewBackupPolicyResource,
		NewBackupPlanResource,
	}
}

func (p *inayaProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{}
}
