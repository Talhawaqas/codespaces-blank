// src/adapters/azure.js -- Azure Blob source adapter (SOW §4.4 Azure
// Blob). Uses the real, official @azure/storage-blob SDK rather than a
// hand-rolled Shared Key client -- an enterprise migrating real Azure
// data should trust the same client Microsoft ships, and Azure's Shared
// Key algorithm/container/blob model has enough surface area (block vs
// page vs append blobs, blob-level metadata) that reimplementing it would
// itself be "a second encryption/[protocol] system," which §4.5's spirit
// argues against even though that clause is written about the
// destination side.

import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

export function createAzureSource({ accountName, accountKey, connectionString, container }) {
  const serviceClient = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        new StorageSharedKeyCredential(accountName, accountKey)
      );
  const containerClient = serviceClient.getContainerClient(container);

  return {
    kind: "azure",

    async assertReachable() {
      const exists = await containerClient.exists();
      if (!exists) throw new Error(`Azure container "${container}" does not exist or is not reachable with the given credential.`);
    },

    /** Async generator of { key, sizeBytes, etag, contentType,
     *  lastModified } -- real paginated listBlobsFlat (SOW §4.4 "blob
     *  enumeration" / "large-object handling"), prefix optional. */
    async *listObjects({ prefix = "" } = {}) {
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        yield {
          key: blob.name,
          sizeBytes: blob.properties.contentLength,
          etag: (blob.properties.etag || "").replace(/"/g, ""),
          contentType: blob.properties.contentType,
          lastModified: blob.properties.lastModified,
        };
      }
    },

    /** Returns { body, contentType, sizeBytes } -- body is a real Node
     *  Readable stream via the SDK's own streaming download. */
    async getObject({ key }) {
      const blobClient = containerClient.getBlobClient(key);
      const resp = await blobClient.download();
      return {
        body: resp.readableStreamBody,
        contentType: resp.contentType || "application/octet-stream",
        sizeBytes: resp.contentLength,
      };
    },
  };
}
