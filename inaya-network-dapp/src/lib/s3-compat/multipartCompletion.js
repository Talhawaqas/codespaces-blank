// src/lib/s3-compat/multipartCompletion.js
//
// SQA-018 (S1): CompleteMultipartUpload was not idempotent and not safe under concurrency. Completing a large object (encrypt, shard, pin twice)
// takes about a minute, which is exactly the default read timeout of the AWS SDKs, so real clients RETRY the request while the first one is still
// running. Both requests then executed the whole completion: the same object was written twice (two 200 responses), and a third retry got
// NoSuchUpload because the first completion had already deleted the upload record.
//
// Now the completion is claimed atomically. Exactly one request does the work; a concurrent or later request for the same upload waits for it and
// returns the SAME result (S3's own behavior for a repeated CompleteMultipartUpload). A completion that fails releases the claim so the client can
// retry; a claim left behind by a process that died is taken over after STALE_MS.

const STALE_MS = 5 * 60 * 1000;

/**
 * @param uploads      the multipart-uploads collection
 * @param ownerFilter  { orgId } or { walletAddress } -- an upload is only ever visible to its owner
 * @param run          async (upload) => the created object row (must have _id); performs the real completion
 * @param readResult   async (id) => the created object row again, for repeated requests
 * @returns the object row, or null when the upload does not exist for this owner
 */
export async function completeOnce({ uploads, ownerFilter, uploadId, run, readResult, waitMs = 55000, pollMs = 1000 }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const upload = await uploads.findOne({ _id: uploadId, ...ownerFilter });
    if (!upload) return null;
    if (upload.completionState === "completed") return await readResult(upload.resultDocumentId);

    const startedAt = upload.completionStartedAt ? Date.parse(upload.completionStartedAt) : 0;
    const stale = upload.completionState === "completing" && Date.now() - startedAt > STALE_MS;
    if (!upload.completionState || stale) {
      const claimFilter = stale
        ? { _id: uploadId, ...ownerFilter, completionState: "completing", completionStartedAt: upload.completionStartedAt }
        : { _id: uploadId, ...ownerFilter, completionState: { $exists: false } };
      const claimed = await uploads.findOneAndUpdate(claimFilter, { $set: { completionState: "completing", completionStartedAt: new Date().toISOString() } });
      if (claimed) {
        try {
          const doc = await run(upload);
          await uploads.updateOne({ _id: uploadId }, { $set: { completionState: "completed", resultDocumentId: doc._id, completedAt: new Date().toISOString() } });
          return doc;
        } catch (err) {
          await uploads.updateOne({ _id: uploadId }, { $unset: { completionState: "", completionStartedAt: "" } });
          throw err;
        }
      }
    }
    if (Date.now() > deadline) throw new Error("This multipart upload is still being completed by an earlier request; retry shortly.");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
