// terraform-provider-inaya -- IBM Cloud VPC Storage Gap Expansion SOW's
// deferred Terraform workstream, built once real Go tooling was available
// in this environment. See docs/ibm-vpc-storage-expansion-report.md (in
// the inaya-network-dapp repo) for why this was originally deferred, and
// this provider's own README.md for its actual, honestly-scoped surface.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/provider"
)

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New, providerserver.ServeOpts{
		Address: "registry.terraform.io/talhawaqas/inaya",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
