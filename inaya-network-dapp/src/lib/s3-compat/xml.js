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
