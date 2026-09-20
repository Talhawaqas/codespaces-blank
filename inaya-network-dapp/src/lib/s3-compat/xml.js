// src/lib/s3-compat/xml.js
//
// Minimal S3-shaped XML response builders -- just the elements the AWS CLI
// / SDK / rclone actually parse for the operations this SOW implements, not
// a full schema of every S3 response type. No XML library dependency; S3
// responses are simple enough to template directly, same "don't add a
// dependency for something this small" judgment as the rest of the repo.

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ERROR_STATUS = {
  AccessDenied: 403,
  InvalidAccessKeyId: 403,
  SignatureDoesNotMatch: 403,
  NoSuchBucket: 404,
  NoSuchKey: 404,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  InvalidRequest: 400,
  NoSuchUpload: 404,
  InternalError: 500,
  // Inaya Drive Empty Folder SOW -- Inaya-specific codes for the ?folder
  // extension (S3 itself has no folder concept, so none of these are real
  // S3 error codes; disclosed as such wherever ?folder is documented).
  FolderAlreadyExists: 409,
  InvalidFolderName: 400,
  NoSuchFolder: 404,
  NoSuchParentFolder: 404,
  // Real S3 error codes for genuinely-unimplemented bucket sub-resources
  // (Enterprise Adoption SOW, Workstream B -- Terraform compatibility).
  NoSuchBucketPolicy: 404,
  NoSuchCORSConfiguration: 404,
  NoSuchWebsiteConfiguration: 404,
  ServerSideEncryptionConfigurationNotFoundError: 404,
  ReplicationConfigurationNotFoundError: 404,
  OwnershipControlsNotFoundError: 404,
  NoSuchPublicAccessBlockConfiguration: 404,
};

export function s3Error(code, message, { requestId = "inaya-" + Date.now().toString(36) } = {}) {
  const status = ERROR_STATUS[code] || 400;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message><RequestId>${esc(requestId)}</RequestId></Error>`;
  return new Response(xml, { status, headers: { "Content-Type": "application/xml" } });
}

export function xmlResponse(xml, { status = 200, headers = {} } = {}) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, { status, headers: { "Content-Type": "application/xml", ...headers } });
}

export function listAllMyBucketsXml(buckets) {
  const items = buckets.map((b) => `<Bucket><Name>${esc(b.name)}</Name><CreationDate>${esc(b.createdAt)}</CreationDate></Bucket>`).join("");
  return `<ListAllMyBucketsResult><Buckets>${items}</Buckets></ListAllMyBucketsResult>`;
}

/** Real S3's bucket-wide GET ?versions response shape -- needed for real
 *  S3 SDK clients (e.g. Terraform's aws_s3_bucket force_destroy, which
 *  must enumerate every version of every object before deleting the
 *  bucket). Single-page only (no KeyMarker/VersionIdMarker pagination
 *  yet) -- a genuine, disclosed limitation, not silently claimed complete;
 *  see the Enterprise Adoption SOW report. */
export function listObjectVersionsXml({ bucket, entries, isTruncated = false }) {
  const items = entries
    .map((v) =>
      v.deleteMarker
        ? `<DeleteMarker><Key>${esc(v.key)}</Key><VersionId>${esc(v.versionId)}</VersionId><IsLatest>${v.isLatest}</IsLatest><LastModified>${esc(v.lastModified)}</LastModified></DeleteMarker>`
        : `<Version><Key>${esc(v.key)}</Key><VersionId>${esc(v.versionId)}</VersionId><IsLatest>${v.isLatest}</IsLatest><LastModified>${esc(v.lastModified)}</LastModified><ETag>&quot;${esc(v.etag || "")}&quot;</ETag><Size>${v.sizeBytes || 0}</Size><StorageClass>STANDARD</StorageClass></Version>`
    )
    .join("");
  return `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(bucket)}</Name><IsTruncated>${isTruncated}</IsTruncated>${items}</ListVersionsResult>`;
}

export function listObjectsV2Xml({ bucket, prefix, delimiter, contents, commonPrefixes, isTruncated }) {
  const items = contents
    .map(
      (doc) =>
        `<Contents><Key>${esc(doc.filename)}</Key><LastModified>${esc(doc.createdAt)}</LastModified><ETag>&quot;${esc(doc.cidAlpha || "")}&quot;</ETag><Size>${doc.sizeBytes}</Size><StorageClass>STANDARD</StorageClass></Contents>`
    )
    .join("");
  const prefixItems = commonPrefixes.map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`).join("");
  return `<ListBucketResult><Name>${esc(bucket)}</Name><Prefix>${esc(prefix || "")}</Prefix><Delimiter>${esc(delimiter || "")}</Delimiter><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>${items}${prefixItems}</ListBucketResult>`;
}

export function initiateMultipartUploadXml({ bucket, key, uploadId }) {
  return `<InitiateMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${esc(uploadId)}</UploadId></InitiateMultipartUploadResult>`;
}

export function completeMultipartUploadXml({ bucket, key, etag }) {
  return `<CompleteMultipartUploadResult><Location>/${esc(bucket)}/${esc(key)}</Location><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><ETag>&quot;${esc(etag)}&quot;</ETag></CompleteMultipartUploadResult>`;
}

/** Parses the XML body of a CompleteMultipartUpload request:
 *  <CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"..."</ETag></Part>...</CompleteMultipartUpload>
 *  Regex-based on purpose -- this is one fixed, simple shape every real S3 SDK sends identically,
 *  not general-purpose XML parsing. */
export function parseCompleteMultipartBody(xmlText) {
  const parts = [];
  const partRegex = /<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>&?quot;?([a-fA-F0-9]+)&?quot;?<\/ETag>\s*<\/Part>/g;
  let match;
  while ((match = partRegex.exec(xmlText)) !== null) {
    parts.push({ partNumber: Number(match[1]), etag: match[2] });
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}
