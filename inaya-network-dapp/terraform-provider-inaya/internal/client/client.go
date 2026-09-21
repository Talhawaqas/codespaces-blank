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
