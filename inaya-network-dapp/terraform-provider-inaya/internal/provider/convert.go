package provider

import (
	"context"
	"math/big"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Talhawaqas/terraform-provider-inaya/internal/client"
)

func storageResourceFromAPI(ctx context.Context, r *client.StorageResource, diags *diag.Diagnostics) storageResourceModel {
	tagsMap, d := types.MapValueFrom(ctx, types.StringType, r.Tags)
	diags.Append(d...)

	capacity := types.NumberNull()
	if r.Capacity != nil {
		capacity = types.NumberValue(big.NewFloat(r.Capacity.RequestedGB))
	}

	return storageResourceModel{
		ID:                 types.StringValue(r.ID),
		Type:               types.StringValue(r.Type),
		Name:               types.StringValue(r.Name),
		Region:             types.StringValue(r.Region),
		CapacityGB:         capacity,
		Tags:               tagsMap,
		Status:             types.StringValue(r.Status),
		PhysicalCapability: types.StringValue(r.PhysicalCapability),
		BackingBucket:      types.StringValue(r.BackingBucket),
	}
}

func snapshotFromAPI(s *client.Snapshot) snapshotModel {
	return snapshotModel{
		ID:               types.StringValue(s.ID),
		SourceResourceID: types.StringValue(s.SourceResourceID),
		SnapshotType:     types.StringValue(s.SnapshotType),
		Status:           types.StringValue(s.Status),
		IntegrityHash:    types.StringValue(s.IntegrityHash),
		CreatedAt:        types.StringValue(s.CreatedAt),
	}
}

func backupPolicyFromAPI(ctx context.Context, p *client.BackupPolicy, diags *diag.Diagnostics) backupPolicyModel {
	selector, d := types.MapValueFrom(ctx, types.StringType, p.TagSelector)
	diags.Append(d...)
	return backupPolicyModel{
		ID:                 types.StringValue(p.ID),
		Name:               types.StringValue(p.Name),
		TagSelector:        selector,
		Enabled:            types.BoolValue(p.Enabled),
		NotificationPolicy: types.StringValue(p.NotificationPolicy),
	}
}

func backupPlanFromAPI(p *client.BackupPlan) backupPlanModel {
	return backupPlanModel{
		ID:             types.StringValue(p.ID),
		PolicyID:       types.StringValue(p.PolicyID),
		Frequency:      types.StringValue(p.Frequency),
		RetentionCount: types.Int64Value(p.RetentionCount),
		Priority:       types.StringValue(p.Priority),
		Health:         types.StringValue(p.Health),
	}
}
