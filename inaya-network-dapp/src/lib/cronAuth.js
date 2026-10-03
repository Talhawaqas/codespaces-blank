// Shared CRON_SECRET bearer check for every scheduled route. Compares SHA-256 digests with
// timingSafeEqual so the comparison time doesn't depend on how much of the secret matched.

import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

export function bearerMatches(authHeader, secret) {
  if (!secret || typeof authHeader !== "string") return false;
  return timingSafeEqual(digest(authHeader), digest(`Bearer ${secret}`));
}

export function isAuthorizedCron(authHeader) {
  return bearerMatches(authHeader, process.env.CRON_SECRET);
}
