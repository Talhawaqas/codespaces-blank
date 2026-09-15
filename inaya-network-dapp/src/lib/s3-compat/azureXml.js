// src/lib/s3-compat/azureXml.js
//
// Azure Blob-shaped XML response builders. Same "no XML library, these
// shapes are simple enough to template directly" judgment as xml.js.

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const AZURE_ERROR_STATUS = {
  AuthenticationFailed: 403,
  ContainerNotFound: 404,
  BlobNotFound: 404,
  ContainerAlreadyExists: 409,
  ContainerBeingDeleted: 409,
  ContainerNotEmpty: 409,
  InvalidBlockList: 400,
  InvalidInput: 400,
  InternalError: 500,
};

export function azureError(code, message) {
  const status = AZURE_ERROR_STATUS[code] || 400;
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error>`;
  return new Response(xml, { status, headers: { "Content-Type": "application/xml", "x-ms-version": "2021-08-06" } });
}

export function azureXmlResponse(xml, { status = 200, headers = {} } = {}) {
  return new Response(`<?xml version="1.0" encoding="utf-8"?>\n${xml}`, {
    status,
    headers: { "Content-Type": "application/xml", "x-ms-version": "2021-08-06", ...headers },
  });
}

export function listContainersXml(containers) {
  const items = containers
    .map((c) => `<Container><Name>${esc(c.name)}</Name><Properties><Last-Modified>${esc(new Date(c.createdAt).toUTCString())}</Last-Modified><LeaseStatus>unlocked</LeaseStatus><LeaseState>available</LeaseState></Properties></Container>`)
    .join("");
  return `<EnumerationResults><Containers>${items}</Containers><NextMarker/></EnumerationResults>`;
}

export function listBlobsXml({ container, prefix, blobs, blobPrefixes }) {
  const items = blobs
    .map(
      (b) =>
        `<Blob><Name>${esc(b.filename)}</Name><Properties><Last-Modified>${esc(new Date(b.createdAt).toUTCString())}</Last-Modified><Etag>&quot;${esc(b.cidAlpha || b.fileHash || "")}&quot;</Etag><Content-Length>${b.sizeBytes ?? b.fileSizeBytes ?? 0}</Content-Length><Content-Type>${esc(b.contentType)}</Content-Type><BlobType>BlockBlob</BlobType></Properties></Blob>`
    )
    .join("");
  const prefixItems = (blobPrefixes || []).map((p) => `<BlobPrefix><Name>${esc(p)}</Name></BlobPrefix>`).join("");
  return `<EnumerationResults ContainerName="${esc(container)}"><Prefix>${esc(prefix || "")}</Prefix><Blobs>${prefixItems}${items}</Blobs><NextMarker/></EnumerationResults>`;
}

/** Parses a Put Block List request body:
 *  <BlockList><Latest>base64BlockId</Latest>...</BlockList>
 *  (also accepts <Committed>/<Uncommitted> tags -- Inaya has no separate
 *  committed/uncommitted block state, so all three tags are treated
 *  identically: "include this block, in this position"). */
export function parseBlockListBody(xmlText) {
  const ids = [];
  const regex = /<(?:Latest|Committed|Uncommitted)>([^<]+)<\/(?:Latest|Committed|Uncommitted)>/g;
  let match;
  while ((match = regex.exec(xmlText)) !== null) ids.push(match[1]);
  return ids;
}
