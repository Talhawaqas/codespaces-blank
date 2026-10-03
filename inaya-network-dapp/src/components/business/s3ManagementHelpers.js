// Pure helpers for S3ManagementPanels.js, kept in plain JS so they can be unit-tested without a JSX toolchain.

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function parseTagInput(text) {
  const tags = {};
  for (const part of String(text || "").split(",")) {
    const [k, ...rest] = part.split("=");
    const key = (k || "").trim();
    if (key) tags[key] = rest.join("=").trim();
  }
  return tags;
}
