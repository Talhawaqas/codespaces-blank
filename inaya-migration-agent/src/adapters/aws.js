// src/adapters/aws.js -- AWS S3 source adapter (SOW §4.4 AWS S3).
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

export function createAwsSource({ region, accessKeyId, secretAccessKey, sessionToken, bucket, endpoint, forcePathStyle }) {
  const client = new S3Client({
    region: region || "us-east-1",
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    ...(endpoint ? { endpoint, forcePathStyle: forcePathStyle ?? true } : {}),
  });

  return {
    kind: "aws",

    async assertReachable() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },

    /** Async generator of { key, sizeBytes, etag, contentType } -- real
     *  paginated ListObjectsV2, not a single-call assumption (SOW §4.4
     *  "object enumeration" / "large-object handling"). */
    async *listObjects({ prefix = "" } = {}) {
      let continuationToken;
      do {
        const resp = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
        );
        for (const obj of resp.Contents || []) {
          yield { key: obj.Key, sizeBytes: obj.Size, etag: (obj.ETag || "").replace(/"/g, ""), lastModified: obj.LastModified };
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (continuationToken);
    },

    /** Returns { body, contentType, sizeBytes } -- body is a real Node
     *  Readable stream, so large objects never load fully into memory. */
    async getObject({ key }) {
      const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { body: resp.Body, contentType: resp.ContentType || "application/octet-stream", sizeBytes: resp.ContentLength };
    },
  };
}
