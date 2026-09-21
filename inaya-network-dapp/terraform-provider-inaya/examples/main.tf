terraform {
  required_providers {
    inaya = {
      source = "talhawaqas/inaya"
    }
  }
}

provider "inaya" {
  endpoint = "https://app.inaya.network" # or http://localhost:3000 for a local dev server
  api_key  = var.inaya_api_key           # or set INAYA_API_KEY instead
}

variable "inaya_api_key" {
  type      = string
  sensitive = true
}

resource "inaya_storage_resource" "app_data" {
  type        = "volume" # or "fileShare"
  name        = "app-data"
  region      = "default" # a logical label -- see the resource's own docs
  capacity_gb = 100
  tags = {
    env = "prod"
  }
}

resource "inaya_backup_policy" "prod" {
  name = "prod-daily"
  tag_selector = {
    env = "prod"
  }
  notification_policy = "onFailure"
}

resource "inaya_backup_plan" "daily" {
  policy_id       = inaya_backup_policy.prod.id
  frequency       = "daily"
  retention_count = 14
}

# A one-off manual snapshot, independent of the scheduled backup plan above.
resource "inaya_snapshot" "pre_migration" {
  source_resource_id = inaya_storage_resource.app_data.id
}

output "backing_bucket" {
  value = inaya_storage_resource.app_data.backing_bucket
}
