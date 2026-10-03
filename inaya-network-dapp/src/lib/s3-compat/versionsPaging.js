// Pagination for S3 ListObjectVersions (GET /bucket?versions).
//
// Real S3 returns entries ordered by key ascending and, within a key, newest version first, at most
// `max-keys` per page, and resumes after the pair (key-marker, version-id-marker). Terraform's
// force_destroy and `aws s3api list-object-versions` page through large buckets this way; a response
// that always claimed to be complete made them drop everything past the first page.

export const DEFAULT_MAX_KEYS = 1000;

/** `entries` must already be ordered key asc, newest version first (what listAllObjectVersions returns). */
export function pageVersions(entries, { keyMarker = "", versionIdMarker = "", maxKeys = DEFAULT_MAX_KEYS } = {}) {
  const limit = Math.min(Math.max(Number.parseInt(maxKeys, 10) || DEFAULT_MAX_KEYS, 1), DEFAULT_MAX_KEYS);

  let start = 0;
  if (keyMarker) {
    if (versionIdMarker) {
      // resume right after that exact version of that key; if it no longer exists, resume after the key
      const at = entries.findIndex((e) => e.key === keyMarker && e.versionId === versionIdMarker);
      start = at >= 0 ? at + 1 : entries.findIndex((e) => e.key > keyMarker);
    } else {
      start = entries.findIndex((e) => e.key > keyMarker);
    }
    if (start < 0) start = entries.length;
  }

  const page = entries.slice(start, start + limit);
  const isTruncated = start + limit < entries.length;
  const last = page[page.length - 1];
  return {
    entries: page,
    isTruncated,
    maxKeys: limit,
    nextKeyMarker: isTruncated ? last.key : null,
    nextVersionIdMarker: isTruncated ? last.versionId : null,
  };
}
