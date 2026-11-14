// Package client is a small hand-rolled HTTP client for Inaya's
// /api/public/v1/storage/* namespace (added alongside this provider --
// see src/app/api/public/v1/storage/**/route.js). It deliberately does
// not use a generated SDK: the surface is eight routes, and a generated
// client would be more code than this file for no real benefit.
//
// Every request carries "Authorization: Bearer <api key>" -- the same
// key an org admin creates via the existing api-keys.js/createApiKey()
// flow (Institutional Trust Infrastructure SOW, Phase 4). The key
// resolves to exactly one org server-side; nothing in this client (or
// the API surface it calls) can point a request at a different org.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Client struct {
	Endpoint string
	APIKey   string
	http     *http.Client
}

func New(endpoint, apiKey string) *Client {
	return &Client{
		Endpoint: strings.TrimRight(endpoint, "/"),
		APIKey:   apiKey,
		http:     &http.Client{},
	}
}

// apiError mirrors the { "error": "..." } shape every route in this
// codebase returns on failure (NextResponse.json({ error: ... })).
type apiError struct {
	Error string `json:"error"`
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.Endpoint+path, reqBody)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("calling %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response from %s %s: %w", method, path, err)
	}

	if resp.StatusCode >= 300 {
		var apiErr apiError
		if jsonErr := json.Unmarshal(respBody, &apiErr); jsonErr == nil && apiErr.Error != "" {
			return fmt.Errorf("%s %s: %s (status %d)", method, path, apiErr.Error, resp.StatusCode)
		}
		return fmt.Errorf("%s %s: unexpected status %d: %s", method, path, resp.StatusCode, string(respBody))
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decoding response from %s %s: %w", method, path, err)
		}
	}
	return nil
}

// --- Storage resources (volumes / file shares) ---------------------------

type CapacityField struct {
	RequestedGB float64 `json:"requestedGB"`
	Enforced    bool    `json:"enforced"`
}

type StorageResource struct {
	ID                 string            `json:"_id"`
	Type               string            `json:"type"`
	Name               string            `json:"name"`
	Region             string            `json:"region"`
	Status             string            `json:"status"`
	Tags               map[string]string `json:"tags"`
	Capacity           *CapacityField    `json:"capacity"`
	PhysicalCapability string            `json:"physicalCapability"`
	AttachmentState    *string           `json:"attachmentState"`
	AttachedTo         *string           `json:"attachedTo"`
	BackingBucket      string            `json:"backingBucket"`
	CreatedAt          string            `json:"createdAt"`
}

type CreateStorageResourceInput struct {
	Type     string            `json:"type"`
	Name     string            `json:"name"`
	Region   string            `json:"region,omitempty"`
	Capacity float64           `json:"capacity,omitempty"`
	Tags     map[string]string `json:"tags,omitempty"`
}

func (c *Client) CreateStorageResource(ctx context.Context, in CreateStorageResourceInput) (*StorageResource, error) {
	var out struct {
		Resource StorageResource `json:"resource"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/storage/resources", in, &out); err != nil {
		return nil, err
	}
	return &out.Resource, nil
}

func (c *Client) GetStorageResource(ctx context.Context, id string) (*StorageResource, error) {
	var out struct {
		Resource StorageResource `json:"resource"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/storage/resources/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out.Resource, nil
}

func (c *Client) ExpandStorageResourceCapacity(ctx context.Context, id string, newCapacityGB float64) error {
	body := map[string]any{"action": "expand", "newCapacityGB": newCapacityGB}
	return c.do(ctx, http.MethodPatch, "/api/public/v1/storage/resources/"+id, body, nil)
}

func (c *Client) DeleteStorageResource(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/storage/resources/"+id, nil, nil)
}

// --- Snapshots -------------------------------------------------------------

type Snapshot struct {
	ID               string `json:"_id"`
	SourceResourceID string `json:"sourceResourceId"`
	SnapshotType     string `json:"snapshotType"`
	Status           string `json:"status"`
	IntegrityHash    string `json:"integrityHash"`
	CreatedAt        string `json:"createdAt"`
}

func (c *Client) CreateSnapshot(ctx context.Context, resourceID string) (*Snapshot, error) {
	var out struct {
		Snapshot Snapshot `json:"snapshot"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/storage/snapshots", map[string]string{"resourceId": resourceID}, &out); err != nil {
		return nil, err
	}
	return &out.Snapshot, nil
}

func (c *Client) GetSnapshot(ctx context.Context, id string) (*Snapshot, error) {
	var out struct {
		Snapshot Snapshot `json:"snapshot"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/storage/snapshots/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out.Snapshot, nil
}

func (c *Client) DeleteSnapshot(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/storage/snapshots/"+id, nil, nil)
}

// --- Backup policies ---------------------------------------------------------

type BackupPolicy struct {
	ID                 string            `json:"_id"`
	Name               string            `json:"name"`
	TagSelector        map[string]string `json:"tagSelector"`
	Enabled            bool              `json:"enabled"`
	NotificationPolicy string            `json:"notificationPolicy"`
	CreatedAt          string            `json:"createdAt"`
}

type CreateBackupPolicyInput struct {
	Name               string            `json:"name"`
	TagSelector        map[string]string `json:"tagSelector,omitempty"`
	NotificationPolicy string            `json:"notificationPolicy,omitempty"`
}

func (c *Client) CreateBackupPolicy(ctx context.Context, in CreateBackupPolicyInput) (*BackupPolicy, error) {
	var out struct {
		Policy BackupPolicy `json:"policy"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/storage/backup-policies", in, &out); err != nil {
		return nil, err
	}
	return &out.Policy, nil
}

func (c *Client) GetBackupPolicy(ctx context.Context, id string) (*BackupPolicy, error) {
	var out struct {
		Policy BackupPolicy `json:"policy"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/storage/backup-policies/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out.Policy, nil
}

func (c *Client) SetBackupPolicyEnabled(ctx context.Context, id string, enabled bool) error {
	return c.do(ctx, http.MethodPatch, "/api/public/v1/storage/backup-policies/"+id, map[string]bool{"enabled": enabled}, nil)
}

func (c *Client) DeleteBackupPolicy(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/storage/backup-policies/"+id, nil, nil)
}

// --- Backup plans ------------------------------------------------------------

type BackupPlan struct {
	ID             string `json:"_id"`
	PolicyID       string `json:"policyId"`
	Frequency      string `json:"frequency"`
	RetentionCount int64  `json:"retentionCount"`
	Priority       string `json:"priority"`
	Health         string `json:"health"`
	CreatedAt      string `json:"createdAt"`
}

type CreateBackupPlanInput struct {
	PolicyID       string `json:"policyId"`
	Frequency      string `json:"frequency"`
	RetentionCount int64  `json:"retentionCount"`
	Priority       string `json:"priority,omitempty"`
}

func (c *Client) CreateBackupPlan(ctx context.Context, in CreateBackupPlanInput) (*BackupPlan, error) {
	var out struct {
		Plan BackupPlan `json:"plan"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/storage/backup-plans", in, &out); err != nil {
		return nil, err
	}
	return &out.Plan, nil
}

func (c *Client) GetBackupPlan(ctx context.Context, id string) (*BackupPlan, error) {
	var out struct {
		Plan BackupPlan `json:"plan"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/storage/backup-plans/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out.Plan, nil
}

func (c *Client) DeleteBackupPlan(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/storage/backup-plans/"+id, nil, nil)
}

// --- Sovereign Infrastructure Fabric: compute, block, network -------------
//
// Unlike storage resources above, creation here is asynchronous: the node
// daemon executes the real QEMU/qcow2/bridge work on its own poll cycle
// (see src/lib/infrastructure/operations.js), so Create's response is the
// resource's initial transient state (CREATING/PROVISIONING), not its
// final one. Create immediately follows up with a real Get so Terraform's
// state always reflects what the control plane actually has on file,
// never a value invented client-side.

type ComputeInstance struct {
	InstanceID string `json:"instanceId"`
	ClusterID  string `json:"clusterId"`
	NodeID     string `json:"nodeId"`
	Name       string `json:"name"`
	Vcpu       int64  `json:"vcpu"`
	MemoryMiB  int64  `json:"memoryMib"`
	VolumeID   string `json:"volumeId"`
	VpcID      string `json:"vpcId"`
	State      string `json:"state"`
	CreatedAt  string `json:"createdAt"`
}

type CreateComputeInstanceInput struct {
	ClusterID string `json:"clusterId"`
	NodeID    string `json:"nodeId"`
	Name      string `json:"name"`
	Vcpu      int64  `json:"vcpu"`
	MemoryMiB int64  `json:"memoryMib"`
	VolumeID  string `json:"volumeId,omitempty"`
	VpcID     string `json:"vpcId,omitempty"`
}

func (c *Client) CreateComputeInstance(ctx context.Context, in CreateComputeInstanceInput) (*ComputeInstance, error) {
	var created struct {
		InstanceID string `json:"instanceId"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/infrastructure/compute/instances", in, &created); err != nil {
		return nil, err
	}
	return c.GetComputeInstance(ctx, created.InstanceID)
}

func (c *Client) GetComputeInstance(ctx context.Context, id string) (*ComputeInstance, error) {
	var out ComputeInstance
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/infrastructure/compute/instances/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) TerminateComputeInstance(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/infrastructure/compute/instances/"+id, nil, nil)
}

type Volume struct {
	VolumeID  string `json:"volumeId"`
	ClusterID string `json:"clusterId"`
	NodeID    string `json:"nodeId"`
	SizeGiB   int64  `json:"sizeGib"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

type CreateVolumeInput struct {
	ClusterID string `json:"clusterId"`
	NodeID    string `json:"nodeId"`
	SizeGiB   int64  `json:"sizeGib"`
}

func (c *Client) CreateVolume(ctx context.Context, in CreateVolumeInput) (*Volume, error) {
	var created struct {
		VolumeID string `json:"volumeId"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/infrastructure/volumes", in, &created); err != nil {
		return nil, err
	}
	return c.GetVolume(ctx, created.VolumeID)
}

func (c *Client) GetVolume(ctx context.Context, id string) (*Volume, error) {
	var out Volume
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/infrastructure/volumes/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteVolume(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/infrastructure/volumes/"+id, nil, nil)
}

type SecurityGroupRuleInput struct {
	Protocol string `json:"protocol"`
	FromPort *int64 `json:"fromPort,omitempty"`
	ToPort   *int64 `json:"toPort,omitempty"`
	Source   string `json:"source,omitempty"`
}

type Vpc struct {
	VpcID     string `json:"vpcId"`
	ClusterID string `json:"clusterId"`
	NodeID    string `json:"nodeId"`
	Cidr      string `json:"cidr"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

type CreateVpcInput struct {
	ClusterID          string                   `json:"clusterId"`
	NodeID             string                   `json:"nodeId"`
	Cidr               string                   `json:"cidr"`
	SecurityGroupRules []SecurityGroupRuleInput `json:"securityGroupRules,omitempty"`
}

func (c *Client) CreateVpc(ctx context.Context, in CreateVpcInput) (*Vpc, error) {
	var created struct {
		VpcID string `json:"vpcId"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/v1/infrastructure/networks", in, &created); err != nil {
		return nil, err
	}
	return c.GetVpc(ctx, created.VpcID)
}

func (c *Client) GetVpc(ctx context.Context, id string) (*Vpc, error) {
	var out Vpc
	if err := c.do(ctx, http.MethodGet, "/api/public/v1/infrastructure/networks/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteVpc(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/public/v1/infrastructure/networks/"+id, nil, nil)
}
