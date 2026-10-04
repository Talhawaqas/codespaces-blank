# Azure endpoint addressing for AzCopy

AzCopy (and some Azure SDK flows) treat the **first path segment of the URL as the container**. A URL like
`https://app.example.com/api/azure/<container>` therefore cannot list or sync properly: AzCopy reads `api` as the container.
(Uploading and downloading single files through that form does work; the middleware repairs the percent-encoded path AzCopy sends.)

The form AzCopy expects is host-based: `https://<azure host>/<container>/<blob>`. This is supported and is **off by default**.

## Turn it on

1. Pick a hostname, for example `azure.inayanetwork.com`, and point DNS and a TLS certificate at this deployment (an operator step; the
   code makes no DNS or TLS changes).
2. Set the environment variable `AZURE_COMPAT_HOST_BASE` to that hostname (no scheme, no port).
3. Requests to that host are served as `/api/azure/...`. Every other host is unchanged.

## Use it

Create a share link (SAS) for the container in **Business Workspace > Storage > Azure SAS links**, then:

```bash
azcopy copy ./folder "https://azure.inayanetwork.com/<container>?<sas>" --recursive --from-to LocalBlob
azcopy list "https://azure.inayanetwork.com/<container>?<sas>" --location Blob
azcopy remove "https://azure.inayanetwork.com/<container>/<blob>?<sas>" --from-to BlobTrash
```

For a non-Azure hostname AzCopy cannot infer the location, so `--from-to` / `--location` are required on every command.
The SAS must include the `inaya-account` parameter that the link generator adds.

## Verified

`test/external-tools-e2e.test.mjs` runs the real AzCopy 10.32 against a local server over a host-based URL (upload of a tree including
a multipart blob, list, byte-for-byte download, remove, plus a read-only link and a tampered link that must each get a real 403).
The same file runs real rclone against the S3 endpoint, and `test/terraform-e2e.test.mjs` runs real Terraform (AWS provider 5.x).
